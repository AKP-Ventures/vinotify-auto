import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { redact } from "../core/logger.js";
import {
  assertAttemptTransition,
  ATTEMPT_STATES,
  isAmbiguousState,
  RESERVATION_STATES,
  utcDayKey,
  utcNow,
} from "../core/types.js";

const RESERVATION_TRANSITIONS = Object.freeze({
  [RESERVATION_STATES.RESERVED]: new Set([
    RESERVATION_STATES.COMMITTED,
    RESERVATION_STATES.RELEASED,
    RESERVATION_STATES.HELD,
  ]),
  [RESERVATION_STATES.HELD]: new Set([
    RESERVATION_STATES.COMMITTED,
    RESERVATION_STATES.RELEASED,
  ]),
  [RESERVATION_STATES.COMMITTED]: new Set(),
  [RESERVATION_STATES.RELEASED]: new Set(),
});

export const DEFAULT_MAX_DATABASE_BYTES = 512 * 1024 * 1024;

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function isStorageFailure(error) {
  const code = String(error?.code ?? "").toUpperCase();
  return ["SQLITE_FULL", "ERR_SQLITE_FULL", "SQLITE_IOERR", "ENOSPC"].includes(code)
    || /database or disk is full|no space left|disk is full/i.test(error?.message ?? "");
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    schemaVersion: Number(row.schema_version),
    searchId: row.search_id,
    searchName: row.search_name,
    detectedAt: row.detected_at,
    receivedAt: row.received_at,
    market: row.market,
    currency: row.currency,
    raw: parseJson(row.raw_json, {}),
  };
}

function rowToItem(row) {
  if (!row) return null;
  return {
    itemKey: row.item_key,
    eventId: row.event_id,
    itemId: row.item_id,
    searchId: row.search_id,
    market: row.market,
    currency: row.currency,
    url: row.url,
    title: row.title,
    priceMinor: Number(row.price_minor),
    raw: parseJson(row.raw_json, {}),
  };
}

function joinedRowToEventAndItem(row) {
  return {
    event: {
      eventId: row.event_id,
      schemaVersion: Number(row.event_schema_version),
      searchId: row.event_search_id,
      searchName: row.event_search_name,
      detectedAt: row.event_detected_at,
      receivedAt: row.event_received_at,
      market: row.event_market,
      currency: row.event_currency,
      raw: parseJson(row.event_raw_json, {}),
    },
    item: {
      itemKey: row.item_key,
      eventId: row.item_event_id,
      itemId: row.item_id,
      searchId: row.item_search_id,
      market: row.item_market,
      currency: row.item_currency,
      url: row.item_url,
      title: row.item_title,
      priceMinor: Number(row.item_price_minor),
      raw: parseJson(row.item_raw_json, {}),
    },
  };
}

function rowToAttempt(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id,
    itemKey: row.item_key,
    eventId: row.event_id,
    searchId: row.search_id,
    itemId: row.item_id,
    mode: row.mode,
    state: row.state,
    reason: row.reason,
    market: row.market,
    currency: row.currency,
    itemPriceMinor: Number(row.item_price_minor),
    finalTotalMinor: row.final_total_minor === null ? null : Number(row.final_total_minor),
    orderId: row.order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recoveryCount: Number(row.recovery_count ?? 0),
  };
}

function rowToReservation(row) {
  if (!row) return null;
  return {
    reservationId: row.reservation_id,
    attemptId: row.attempt_id,
    dayKey: row.day_key,
    currency: row.currency,
    amountMinor: Number(row.amount_minor),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function makeItemKey({ searchId, market, itemId }) {
  return `${String(searchId)}:${String(market).toUpperCase()}:${String(itemId)}`;
}

export class AgentStore {
  constructor(database, { clock = () => new Date(), maxDatabaseBytes = DEFAULT_MAX_DATABASE_BYTES } = {}) {
    this.database = database;
    this.clock = clock;
    this.maxDatabaseBytes = maxDatabaseBytes;
    this.storageDegraded = null;
  }

  now() {
    return this.clock().toISOString();
  }

  getSetting(key, fallback = null) {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
    return row ? parseJson(row.value_json, fallback) : fallback;
  }

  setSetting(key, value) {
    const now = this.now();
    this.database.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, json(value), now);
  }

  getAccountFingerprint() {
    const value = this.getSetting("account_fingerprint", null);
    return typeof value === "string" && value.trim() ? value : null;
  }

  /**
   * Bind this database to the opaque account scope returned by discovery.
   * Existing durable state without an identity is quarantined rather than
   * guessed: it may have been produced by an older token/account.
   */
  bindAccountFingerprint(accountFingerprint) {
    if (typeof accountFingerprint !== "string" || !accountFingerprint.trim() || accountFingerprint.length > 512) {
      return { ok: false, code: "account_scope_missing", reason: "invalid_account_fingerprint" };
    }
    const normalized = accountFingerprint.trim();
    if (this.getSetting("account_scope_quarantine", null)) {
      return { ok: false, code: "account_scope_quarantined", reason: "account_scope_quarantined" };
    }
    const existing = this.getAccountFingerprint();
    if (existing && existing !== normalized) {
      try {
        this.setSetting("account_scope_quarantine", {
          reason: "account_fingerprint_changed",
          observedAt: this.now(),
        });
      } catch (error) {
        this.markStorageDegraded(error);
      }
      return { ok: false, code: "account_scope_mismatch", reason: "account_scope_mismatch" };
    }
    if (!existing && this.hasPersistedWork()) {
      try {
        this.setSetting("account_scope_quarantine", {
          reason: "unbound_persisted_state",
          observedAt: this.now(),
        });
      } catch (error) {
        this.markStorageDegraded(error);
      }
      return { ok: false, code: "account_scope_quarantined", reason: "unbound_persisted_state" };
    }
    if (!existing) this.setSetting("account_fingerprint", normalized);
    return { ok: true, accountFingerprint: normalized, changed: !existing };
  }

  bindAccountScope(accountFingerprint) {
    return this.bindAccountFingerprint(accountFingerprint);
  }

  hasPersistedWork() {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM feed_cursors) AS cursors,
        (SELECT COUNT(*) FROM feed_events) AS events,
        (SELECT COUNT(*) FROM feed_items) AS items,
        (SELECT COUNT(*) FROM purchase_attempts) AS attempts,
        (SELECT COUNT(*) FROM budget_reservations) AS reservations
    `).get();
    return [row.cursors, row.events, row.items, row.attempts, row.reservations]
      .some((value) => Number(value) > 0);
  }

  storageStatus() {
    return {
      state: this.storageDegraded ? "degraded" : "ok",
      reason: this.storageDegraded?.code ?? null,
      maxDatabaseBytes: this.maxDatabaseBytes,
    };
  }

  markStorageDegraded(error) {
    this.storageDegraded = {
      code: error?.code ?? "storage_error",
      message: String(error?.message ?? "storage_error").slice(0, 160),
    };
  }

  #storageSizeBytes() {
    if (!this.maxDatabaseBytes || this.database.filename === ":memory:") return 0;
    let total = 0;
    for (const filename of [this.database.filename, `${this.database.filename}-wal`, `${this.database.filename}-shm`]) {
      try {
        total += statSync(filename).size;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return total;
  }

  #ensureStorageCapacity() {
    if (!this.maxDatabaseBytes || this.database.filename === ":memory:") return;
    let size;
    try {
      size = this.#storageSizeBytes();
    } catch (error) {
      this.markStorageDegraded(error);
      throw error;
    }
    if (size < this.maxDatabaseBytes) return;
    try {
      this.cleanup({ maxDatabaseBytes: this.maxDatabaseBytes });
      size = this.#storageSizeBytes();
    } catch (error) {
      this.markStorageDegraded(error);
      throw error;
    }
    if (size >= this.maxDatabaseBytes) {
      const error = new Error("SQLite storage quota exceeded; retained active work cannot be pruned safely");
      error.code = "storage_quota_exceeded";
      this.markStorageDegraded(error);
      throw error;
    }
    this.storageDegraded = null;
  }

  getCursor(feedName) {
    const row = this.database.prepare(
      "SELECT feed_name, cursor, cursor_expires_at, updated_at FROM feed_cursors WHERE feed_name = ?",
    ).get(feedName);
    return row ? {
      feedName: row.feed_name,
      cursor: row.cursor,
      cursorExpiresAt: row.cursor_expires_at,
      updatedAt: row.updated_at,
    } : null;
  }

  setCursor(feedName, cursor, cursorExpiresAt = null) {
    const now = this.now();
    this.database.prepare(`
      INSERT INTO feed_cursors(feed_name, cursor, cursor_expires_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(feed_name) DO UPDATE SET
        cursor = excluded.cursor,
        cursor_expires_at = excluded.cursor_expires_at,
        updated_at = excluded.updated_at
    `).run(feedName, cursor ?? null, cursorExpiresAt ?? null, now);
  }

  /**
   * Atomically persist all events/items from a feed page and advance its
   * cursor. A failed transaction leaves both the data and cursor unchanged.
   */
  ingestFeedBatch(feedName, { schemaVersion, events, nextCursor, cursorExpiresAt = null }) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    this.#ensureStorageCapacity();
    const now = this.now();
    try {
      return this.database.transaction(() => {
      const insertedEvents = [];
      const duplicateEvents = [];
      const insertedItems = [];
      const duplicateItems = [];
      const insertEvent = this.database.prepare(`
        INSERT OR IGNORE INTO feed_events(
          event_id, schema_version, search_id, search_name, detected_at,
          received_at, market, currency, raw_json, inserted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const eventExists = this.database.prepare("SELECT event_id FROM feed_events WHERE event_id = ?");
      const insertItem = this.database.prepare(`
        INSERT OR IGNORE INTO feed_items(
          item_key, event_id, item_id, search_id, market, currency,
          url, title, price_minor, raw_json, inserted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const itemExists = this.database.prepare("SELECT item_key FROM feed_items WHERE item_key = ?");

      for (const event of events) {
        const result = insertEvent.run(
          event.eventId,
          Number(event.schemaVersion ?? schemaVersion),
          String(event.searchId),
          event.searchName ?? null,
          event.detectedAt,
          event.receivedAt ?? now,
          String(event.market).toUpperCase(),
          String(event.currency).toUpperCase(),
          json(event.raw ?? event),
          now,
        );
        const isNewEvent = Number(result.changes) > 0;
        (isNewEvent ? insertedEvents : duplicateEvents).push(event.eventId);
        if (!isNewEvent) {
          // Event IDs are immutable replay keys. Do not allow a malformed or
          // malicious replay with the same ID to smuggle new items into the
          // durable queue.
          continue;
        }
        for (const item of event.items ?? []) {
          const itemKey = item.itemKey ?? makeItemKey({ searchId: event.searchId, market: event.market, itemId: item.itemId });
          const itemResult = insertItem.run(
            itemKey,
            event.eventId,
            String(item.itemId),
            String(event.searchId),
            String(item.market ?? event.market).toUpperCase(),
            String(item.currency ?? event.currency).toUpperCase(),
            item.url,
            item.title ?? "",
            item.priceMinor,
            json(item.raw ?? item),
            now,
          );
          if (Number(itemResult.changes) > 0) insertedItems.push(itemKey);
          else if (itemExists.get(itemKey)) duplicateItems.push(itemKey);
        }
      }
      this.database.prepare(`
        INSERT INTO feed_cursors(feed_name, cursor, cursor_expires_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(feed_name) DO UPDATE SET
          cursor = excluded.cursor,
          cursor_expires_at = excluded.cursor_expires_at,
          updated_at = excluded.updated_at
      `).run(feedName, nextCursor ?? null, cursorExpiresAt ?? null, now);
        return { insertedEvents, duplicateEvents, insertedItems, duplicateItems, nextCursor: nextCursor ?? null };
      });
    } catch (error) {
      if (isStorageFailure(error)) {
        this.markStorageDegraded(error);
      }
      throw error;
    }
  }

  getEvent(eventId) {
    return rowToEvent(this.database.prepare("SELECT * FROM feed_events WHERE event_id = ?").get(eventId));
  }

  getItem(itemKey) {
    return rowToItem(this.database.prepare("SELECT * FROM feed_items WHERE item_key = ?").get(itemKey));
  }

  listItemsForEvent(eventId) {
    return this.database.prepare("SELECT * FROM feed_items WHERE event_id = ? ORDER BY rowid")
      .all(eventId).map(rowToItem);
  }

  /**
   * Return persisted feed items that have never acquired a purchase_attempt.
   * An attempt in any state (including skipped, failed, or unknown) counts as
   * attempted: recovery must not manufacture a second purchase attempt for an
   * item whose first attempt already crossed a policy or payment boundary.
   */
  listUnattemptedFeedItems({ searchId = null, limit = 1_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be positive");
    const predicates = ["a.item_key IS NULL"];
    const params = [];
    if (searchId !== null && searchId !== undefined) {
      predicates.push("i.search_id = ?");
      params.push(String(searchId));
    }
    return this.database.prepare(`
      SELECT i.*
      FROM feed_items AS i
      LEFT JOIN purchase_attempts AS a ON a.item_key = i.item_key
      WHERE ${predicates.join(" AND ")}
      ORDER BY i.event_id ASC, i.item_key ASC
      LIMIT ?
    `).all(...params, limit).map(rowToItem);
  }

  /**
   * Reconstruct normalized events for startup recovery. Events are ordered by
   * detected_at then event_id; items are ordered by their stable item_key.
   * Fully attempted events are absent, while partially attempted events carry
   * only their still-unattempted items.
   */
  listUnattemptedFeedEvents({ searchId = null, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be positive");
    const candidatePredicates = ["a.item_key IS NULL"];
    const candidateParams = [];
    if (searchId !== null && searchId !== undefined) {
      candidatePredicates.push("e.search_id = ?");
      candidateParams.push(String(searchId));
    }
    const rows = this.database.prepare(`
      WITH candidate_events AS (
        SELECT e.event_id, e.detected_at
        FROM feed_events AS e
        JOIN feed_items AS i ON i.event_id = e.event_id
        LEFT JOIN purchase_attempts AS a ON a.item_key = i.item_key
        WHERE ${candidatePredicates.join(" AND ")}
        GROUP BY e.event_id, e.detected_at
        ORDER BY e.detected_at ASC, e.event_id ASC
        LIMIT ?
      )
      SELECT
        e.event_id AS event_id,
        e.schema_version AS event_schema_version,
        e.search_id AS event_search_id,
        e.search_name AS event_search_name,
        e.detected_at AS event_detected_at,
        e.received_at AS event_received_at,
        e.market AS event_market,
        e.currency AS event_currency,
        e.raw_json AS event_raw_json,
        i.event_id AS item_event_id,
        i.item_key AS item_key,
        i.item_id AS item_id,
        i.search_id AS item_search_id,
        i.market AS item_market,
        i.currency AS item_currency,
        i.url AS item_url,
        i.title AS item_title,
        i.price_minor AS item_price_minor,
        i.raw_json AS item_raw_json
      FROM candidate_events AS c
      JOIN feed_events AS e ON e.event_id = c.event_id
      JOIN feed_items AS i ON i.event_id = e.event_id
      LEFT JOIN purchase_attempts AS a ON a.item_key = i.item_key
      WHERE a.item_key IS NULL
      ORDER BY e.detected_at ASC, e.event_id ASC, i.item_key ASC
    `).all(...candidateParams, limit);

    const events = [];
    const byId = new Map();
    for (const row of rows) {
      const { event, item } = joinedRowToEventAndItem(row);
      let normalized = byId.get(event.eventId);
      if (!normalized) {
        normalized = { ...event, items: [] };
        byId.set(event.eventId, normalized);
        events.push(normalized);
      }
      normalized.items.push(item);
    }
    return events;
  }

  // Short aliases keep the recovery API discoverable without duplicating SQL.
  listUnattemptedEvents(options) {
    return this.listUnattemptedFeedEvents(options);
  }

  createAttempt({
    itemKey,
    eventId,
    searchId,
    itemId,
    mode,
    state = ATTEMPT_STATES.RECEIVED,
    reason = null,
    market,
    currency,
    itemPriceMinor,
  }) {
    return this.database.transaction(() => {
      const now = this.now();
      const attemptId = randomUUID();
      this.database.prepare(`
        INSERT INTO purchase_attempts(
          attempt_id, item_key, event_id, search_id, item_id, mode, state, reason,
          market, currency, item_price_minor, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId, itemKey, eventId, String(searchId), String(itemId), mode, state, reason,
        String(market).toUpperCase(), String(currency).toUpperCase(), itemPriceMinor, now, now,
      );
      this.database.prepare(`
        INSERT INTO attempt_transitions(attempt_id, from_state, to_state, reason, metadata_json, created_at)
        VALUES (?, NULL, ?, ?, NULL, ?)
      `).run(attemptId, state, reason, now);
      return this.getAttempt(attemptId);
    });
  }

  getAttempt(attemptId) {
    return rowToAttempt(this.database.prepare("SELECT * FROM purchase_attempts WHERE attempt_id = ?").get(attemptId));
  }

  getAttemptByItemKey(itemKey) {
    return rowToAttempt(this.database.prepare("SELECT * FROM purchase_attempts WHERE item_key = ?").get(itemKey));
  }

  listAttempts({ states = null, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be positive");
    if (!states?.length) {
      return this.database.prepare("SELECT * FROM purchase_attempts ORDER BY created_at, rowid LIMIT ?")
        .all(limit).map(rowToAttempt);
    }
    const placeholders = states.map(() => "?").join(",");
    return this.database.prepare(
      `SELECT * FROM purchase_attempts WHERE state IN (${placeholders}) ORDER BY created_at, rowid LIMIT ?`,
    ).all(...states, limit).map(rowToAttempt);
  }

  listRecentAttempts(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be positive");
    return this.database.prepare(
      "SELECT * FROM purchase_attempts ORDER BY updated_at DESC, rowid DESC LIMIT ?",
    ).all(limit).map(rowToAttempt);
  }

  getNextQueuedAttempt() {
    return rowToAttempt(this.database.prepare(
      "SELECT * FROM purchase_attempts WHERE state = ? ORDER BY created_at, rowid LIMIT 1",
    ).get(ATTEMPT_STATES.QUEUED));
  }

  transitionAttempt(attemptId, toState, { reason = null, metadata = null, finalTotalMinor, orderId } = {}) {
    return this.database.transaction(() => this._transitionAttempt(attemptId, toState, {
      reason,
      metadata,
      finalTotalMinor,
      orderId,
    }));
  }

  _transitionAttempt(attemptId, toState, { reason = null, metadata = null, finalTotalMinor, orderId, recovery = false } = {}) {
    const now = this.now();
    const current = this.getAttempt(attemptId);
    if (!current) throw new Error(`Attempt not found: ${attemptId}`);
    if (recovery) {
      const allowedRecovery = [
        ATTEMPT_STATES.NEEDS_USER_ACTION,
        ATTEMPT_STATES.LISTING_CHECKED,
        ATTEMPT_STATES.CHECKOUT_OPENED,
        ATTEMPT_STATES.TOTAL_VERIFIED,
      ];
      if (toState !== ATTEMPT_STATES.QUEUED || !allowedRecovery.includes(current.state)) {
        throw new Error(`Invalid recovery transition: ${current.state} -> ${toState}`);
      }
    } else {
      assertAttemptTransition(current.state, toState);
    }
    const nextFinal = finalTotalMinor === undefined ? current.finalTotalMinor : finalTotalMinor;
    const nextOrderId = orderId === undefined ? current.orderId : orderId;
    this.database.prepare(`
      UPDATE purchase_attempts
      SET state = ?, reason = ?, final_total_minor = ?, order_id = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(toState, reason, nextFinal, nextOrderId, now, attemptId);
    this.database.prepare(`
      INSERT INTO attempt_transitions(attempt_id, from_state, to_state, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(attemptId, current.state, toState, reason, metadata === null ? null : json(redact(metadata)), now);
    return this.getAttempt(attemptId);
  }

  incrementRecoveryCount(attemptId) {
    this.database.prepare(
      "UPDATE purchase_attempts SET recovery_count = recovery_count + 1, updated_at = ? WHERE attempt_id = ?",
    ).run(this.now(), attemptId);
  }

  requeuePreSubmitAttempt(attemptId) {
    return this.database.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.state !== ATTEMPT_STATES.NEEDS_USER_ACTION) {
        throw new Error("Attempt is not waiting for a pre-submit user action");
      }
      const isPreSubmitReason = String(attempt.reason ?? "").startsWith("pre_submit_");
      if (!isPreSubmitReason && attempt.reason !== "disarmed_before_payment") {
        throw new Error("Attempt has crossed the payment boundary and cannot be requeued");
      }
      if (!this.getReservation(attemptId)) throw new Error("Attempt has no budget reservation");
      const queued = this._transitionAttempt(attemptId, ATTEMPT_STATES.QUEUED, {
        reason: "user_action_completed",
        recovery: true,
      });
      this.incrementRecoveryCount(attemptId);
      return queued;
    });
  }

  listTransitions(attemptId) {
    return this.database.prepare(
      "SELECT * FROM attempt_transitions WHERE attempt_id = ? ORDER BY transition_id",
    ).all(attemptId).map((row) => ({
      transitionId: Number(row.transition_id),
      attemptId: row.attempt_id,
      fromState: row.from_state,
      toState: row.to_state,
      reason: row.reason,
      metadata: parseJson(row.metadata_json),
      createdAt: row.created_at,
    }));
  }

  /**
   * Recover only pre-payment work. Anything at or after payment submission is
   * made unknown so a restart can never cause a duplicate payment attempt.
   */
  recoverAfterCrash() {
    const recoverable = [
      ATTEMPT_STATES.RECEIVED,
      ATTEMPT_STATES.VALIDATED,
      ATTEMPT_STATES.QUEUED,
      ATTEMPT_STATES.LISTING_CHECKED,
      ATTEMPT_STATES.CHECKOUT_OPENED,
      ATTEMPT_STATES.TOTAL_VERIFIED,
    ];
    const inFlightAmbiguous = [ATTEMPT_STATES.PAYMENT_SUBMITTED, ATTEMPT_STATES.CONFIRMING];
    return this.database.transaction(() => {
      const recovered = [];
      const ambiguous = [];
      for (const attempt of this.listAttempts({ states: recoverable.concat(inFlightAmbiguous), limit: 100_000 })) {
        if (attempt.state === ATTEMPT_STATES.RECEIVED) {
          // The attempt row was persisted before validation/reservation. It
          // cannot be safely reconstructed from here, so quarantine it rather
          // than inventing a budget reservation.
          this._transitionAttempt(attempt.attemptId, ATTEMPT_STATES.FAILED, {
            reason: "recovered_incomplete_before_validation",
          });
          this._markReservation(attempt.attemptId, RESERVATION_STATES.RELEASED);
          continue;
        }
        if (attempt.state === ATTEMPT_STATES.VALIDATED) {
          const reservation = this.getReservation(attempt.attemptId);
          if (!reservation) {
            this._transitionAttempt(attempt.attemptId, ATTEMPT_STATES.FAILED, {
              reason: "recovered_incomplete_before_reservation",
            });
            continue;
          }
          this._transitionAttempt(attempt.attemptId, ATTEMPT_STATES.QUEUED, {
            reason: "recovered_after_reservation",
            recovery: true,
          });
          this.incrementRecoveryCount(attempt.attemptId);
          recovered.push(attempt.attemptId);
          continue;
        }
        if (attempt.state === ATTEMPT_STATES.QUEUED) {
          // A queued row is already safe; this still increments a restart audit counter.
          this.incrementRecoveryCount(attempt.attemptId);
          recovered.push(attempt.attemptId);
          continue;
        }
        if (inFlightAmbiguous.includes(attempt.state)) {
          this._transitionAttempt(attempt.attemptId, ATTEMPT_STATES.UNKNOWN, {
            reason: "recovered_after_possible_payment_submission",
          });
          this._markReservation(attempt.attemptId, RESERVATION_STATES.HELD);
          ambiguous.push(attempt.attemptId);
          continue;
        }
        // Pre-submit stages can safely re-enter the serial queue.
        this._transitionAttempt(attempt.attemptId, ATTEMPT_STATES.QUEUED, {
          reason: "recovered_before_payment_submission",
          recovery: true,
        });
        this.incrementRecoveryCount(attempt.attemptId);
        recovered.push(attempt.attemptId);
      }
      // A crash can occur after the attempt state transition but before the
      // separate reservation update. Reconcile conservatively on startup.
      for (const reservation of this.database.prepare("SELECT * FROM budget_reservations WHERE state IN (?, ?, ?)").all(
        RESERVATION_STATES.RESERVED,
        RESERVATION_STATES.COMMITTED,
        RESERVATION_STATES.HELD,
      ).map(rowToReservation)) {
        const attempt = this.getAttempt(reservation.attemptId);
        if (!attempt) continue;
        if ([ATTEMPT_STATES.FAILED, ATTEMPT_STATES.DRY_RUN, ATTEMPT_STATES.SKIPPED].includes(attempt.state)) {
          if (reservation.state !== RESERVATION_STATES.RELEASED) {
            this._markReservation(reservation.attemptId, RESERVATION_STATES.RELEASED);
          }
        } else if (attempt.state === ATTEMPT_STATES.SUCCEEDED && reservation.state === RESERVATION_STATES.RESERVED) {
          this._markReservation(reservation.attemptId, RESERVATION_STATES.COMMITTED);
        } else if (attempt.state === ATTEMPT_STATES.UNKNOWN && reservation.state === RESERVATION_STATES.RESERVED) {
          this._markReservation(reservation.attemptId, RESERVATION_STATES.HELD);
        }
      }
      return { recovered, ambiguous };
    });
  }

  getReservation(attemptId) {
    return rowToReservation(this.database.prepare(
      "SELECT * FROM budget_reservations WHERE attempt_id = ?",
    ).get(attemptId));
  }

  reserveBudget({ attemptId, amountMinor, currency, now = this.clock(), maxDailySpendMinor = null, maxDailyCount = null }) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new TypeError("amountMinor must be positive");
    const dayKey = utcDayKey(now);
    const normalizedCurrency = String(currency).toUpperCase();
    return this.database.transaction(() => {
      const existing = this.getReservation(attemptId);
      if (existing) return existing;
      const usage = this.getDailyUsage(dayKey, normalizedCurrency);
      if (maxDailySpendMinor !== null && usage.spendMinor + amountMinor > maxDailySpendMinor) {
        throw new Error("daily_spend_exceeds_limit");
      }
      if (maxDailyCount !== null && usage.count >= maxDailyCount) {
        throw new Error("daily_count_exceeds_limit");
      }
      const timestamp = this.now();
      this.database.prepare(`
        INSERT INTO budget_reservations(
          reservation_id, attempt_id, day_key, currency, amount_minor, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), attemptId, dayKey, normalizedCurrency, amountMinor,
        RESERVATION_STATES.RESERVED, timestamp, timestamp);
      return this.getReservation(attemptId);
    });
  }

  adjustReservation({ attemptId, amountMinor, maxDailySpendMinor = null }) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new TypeError("amountMinor must be positive");
    return this.database.transaction(() => {
      const current = this.getReservation(attemptId);
      if (!current) throw new Error(`Reservation not found: ${attemptId}`);
      const usage = this.getDailyUsage(current.dayKey, current.currency, { excludeAttemptId: attemptId });
      if (maxDailySpendMinor !== null && usage.spendMinor + amountMinor > maxDailySpendMinor) {
        throw new Error("daily_spend_exceeds_limit");
      }
      this.database.prepare(
        "UPDATE budget_reservations SET amount_minor = ?, updated_at = ? WHERE attempt_id = ?",
      ).run(amountMinor, this.now(), attemptId);
      return this.getReservation(attemptId);
    });
  }

  markReservation(attemptId, state) {
    if (!Object.values(RESERVATION_STATES).includes(state)) throw new TypeError(`Invalid reservation state: ${state}`);
    return this.database.transaction(() => this._markReservation(attemptId, state));
  }

  _markReservation(attemptId, state) {
    const current = this.getReservation(attemptId);
    if (!current) return null;
    if (current.state !== state && !RESERVATION_TRANSITIONS[current.state]?.has(state)) {
      throw new Error(`Invalid reservation transition: ${current.state} -> ${state}`);
    }
    this.database.prepare(
      "UPDATE budget_reservations SET state = ?, updated_at = ? WHERE attempt_id = ?",
    ).run(state, this.now(), attemptId);
    return this.getReservation(attemptId);
  }

  getDailyUsage(dayKey, currency, { excludeAttemptId = null } = {}) {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(amount_minor), 0) AS spend_minor, COUNT(*) AS count
      FROM budget_reservations
      WHERE day_key = ? AND currency = ? AND state IN (?, ?, ?)
        AND (? IS NULL OR attempt_id != ?)
    `).get(
      dayKey,
      String(currency).toUpperCase(),
      RESERVATION_STATES.RESERVED,
      RESERVATION_STATES.COMMITTED,
      RESERVATION_STATES.HELD,
      excludeAttemptId,
      excludeAttemptId,
    );
    return { spendMinor: Number(row.spend_minor), count: Number(row.count) };
  }

  appendLog(record) {
    const now = this.now();
    try {
      this.#ensureStorageCapacity();
    } catch (error) {
      // Logging is best-effort. A quota or filesystem failure must not turn a
      // completed state transition into an exception path that could be
      // retried as a purchase.
      this.markStorageDegraded(error);
      return { persisted: false, degraded: true };
    }
    try {
      this.database.prepare(
        "INSERT INTO local_logs(level, event, record_json, created_at) VALUES (?, ?, ?, ?)",
      ).run(record.level, record.event, json(record), now);
      return { persisted: true };
    } catch (error) {
      if (isStorageFailure(error)) {
        // Logging must not turn a safe purchase state transition into an
        // unsafe retry loop when the disk is full. The caller still receives
        // the redacted stdout record; persistence is reported as degraded.
        this.markStorageDegraded(error);
        return { persisted: false, degraded: true };
      }
      throw error;
    }
  }

  listLogs(limit = 100) {
    return this.database.prepare("SELECT * FROM local_logs ORDER BY log_id DESC LIMIT ?").all(limit)
      .map((row) => ({
        logId: Number(row.log_id),
        level: row.level,
        event: row.event,
        record: parseJson(row.record_json, {}),
        createdAt: row.created_at,
      }));
  }

  /**
   * Bound local history without touching live cursors or any nonterminal,
   * ambiguous, reserved, or held work. Deletions are intentionally small and
   * transactional; no VACUUM is issued from a hot path.
   */
  cleanup({
    now = this.clock(),
    attemptRetentionDays = 30,
    logRetentionDays = 14,
    maxLogRows = 10_000,
    maxDatabaseBytes = this.maxDatabaseBytes,
    batchSize = 250,
  } = {}) {
    if (!Number.isSafeInteger(attemptRetentionDays) || attemptRetentionDays <= 0) {
      throw new TypeError("attemptRetentionDays must be a positive integer");
    }
    if (!Number.isSafeInteger(logRetentionDays) || logRetentionDays <= 0) {
      throw new TypeError("logRetentionDays must be a positive integer");
    }
    if (!Number.isSafeInteger(maxLogRows) || maxLogRows <= 0) {
      throw new TypeError("maxLogRows must be a positive integer");
    }
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 10_000) {
      throw new TypeError("batchSize must be an integer between 1 and 10000");
    }
    const nowDate = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(nowDate.valueOf())) throw new TypeError("now must be a valid date");
    const attemptCutoff = new Date(nowDate.valueOf() - attemptRetentionDays * 86_400_000).toISOString();
    const logCutoff = new Date(nowDate.valueOf() - logRetentionDays * 86_400_000).toISOString();
    const terminalStates = [
      ATTEMPT_STATES.SUCCEEDED,
      ATTEMPT_STATES.FAILED,
      ATTEMPT_STATES.DRY_RUN,
      ATTEMPT_STATES.SKIPPED,
    ];
    const placeholders = terminalStates.map(() => "?").join(",");

    try {
      const result = this.database.transaction(() => {
        const candidates = this.database.prepare(`
          SELECT attempt_id, item_key
          FROM purchase_attempts
          WHERE state IN (${placeholders}) AND updated_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM budget_reservations
              WHERE budget_reservations.attempt_id = purchase_attempts.attempt_id
                AND budget_reservations.state IN (?, ?)
            )
          ORDER BY updated_at ASC, rowid ASC
          LIMIT ?
        `).all(...terminalStates, attemptCutoff, RESERVATION_STATES.RESERVED, RESERVATION_STATES.HELD, batchSize);
        const attemptIds = candidates.map((row) => row.attempt_id);
        const itemKeys = candidates.map((row) => row.item_key);
        if (attemptIds.length > 0) {
          const attemptMarks = attemptIds.map(() => "?").join(",");
          // Preserve every transition for attempts that remain. For selected
          // terminal attempts, all dependent audit rows are removed together.
          this.database.prepare(`DELETE FROM attempt_transitions WHERE attempt_id IN (${attemptMarks})`)
            .run(...attemptIds);
          this.database.prepare(`DELETE FROM budget_reservations WHERE attempt_id IN (${attemptMarks}) AND state IN (?, ?)`)
            .run(...attemptIds, RESERVATION_STATES.RELEASED, RESERVATION_STATES.COMMITTED);
          this.database.prepare(`DELETE FROM purchase_attempts WHERE attempt_id IN (${attemptMarks})`)
            .run(...attemptIds);
          const itemMarks = itemKeys.map(() => "?").join(",");
          if (itemKeys.length > 0) {
            this.database.prepare(`DELETE FROM feed_items WHERE item_key IN (${itemMarks}) AND NOT EXISTS (
              SELECT 1 FROM purchase_attempts WHERE purchase_attempts.item_key = feed_items.item_key
            )`).run(...itemKeys);
          }
        }

        const deletedLogsByAge = this.database.prepare(`
          DELETE FROM local_logs
          WHERE log_id IN (
            SELECT log_id FROM local_logs
            WHERE created_at < ?
            ORDER BY log_id ASC
            LIMIT ?
          )
        `).run(logCutoff, batchSize);

        const overflow = this.database.prepare(`
          SELECT log_id FROM local_logs
          ORDER BY log_id DESC
          LIMIT 1 OFFSET ?
        `).get(maxLogRows);
        let deletedLogsByQuota = 0;
        if (overflow) {
          const deleted = this.database.prepare("DELETE FROM local_logs WHERE log_id <= ?").run(overflow.log_id);
          deletedLogsByQuota = Number(deleted.changes ?? 0);
        }

        // Events with no remaining items are safe to remove. Items belonging
        // to unattempted or active work keep their event and audit context.
        const orphanEvents = this.database.prepare(`
          DELETE FROM feed_events
          WHERE inserted_at < ?
            AND NOT EXISTS (SELECT 1 FROM feed_items WHERE feed_items.event_id = feed_events.event_id)
        `).run(attemptCutoff);
        return {
          deletedAttempts: attemptIds.length,
          deletedItems: itemKeys.length,
          deletedEvents: Number(orphanEvents.changes ?? 0),
          deletedLogs: Number(deletedLogsByAge.changes ?? 0) + deletedLogsByQuota,
        };
      });
      if (maxDatabaseBytes && this.database.filename !== ":memory:") {
        try {
          if (this.#storageSizeBytes() < maxDatabaseBytes) this.storageDegraded = null;
        } catch (error) {
          this.markStorageDegraded(error);
        }
      }
      return result;
    } catch (error) {
      this.markStorageDegraded(error);
      throw error;
    }
  }

  prune(options) {
    return this.cleanup(options);
  }

  /**
   * Return only attempts that may be executed by the serial worker. This is
   * intentionally a strict whitelist instead of “not terminal”.
   */
  listRunnableAttempts(limit = 100) {
    return this.listAttempts({ states: [ATTEMPT_STATES.QUEUED], limit });
  }

  isAmbiguous(attemptId) {
    const attempt = this.getAttempt(attemptId);
    return Boolean(attempt && isAmbiguousState(attempt.state));
  }
}
