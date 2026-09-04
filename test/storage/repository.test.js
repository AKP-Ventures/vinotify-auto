import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalDatabase } from "../../src/storage/database.js";
import { AgentStore } from "../../src/storage/repository.js";
import { makeItemKey } from "../../src/storage/repository.js";
import { ATTEMPT_STATES, RESERVATION_STATES } from "../../src/core/types.js";
import { makeClock, makeEvent, makePage, NOW } from "../helpers.js";

function storeWithEvent() {
  const clock = makeClock();
  const database = new LocalDatabase(":memory:", { clock: clock.now });
  const store = new AgentStore(database, { clock: clock.now });
  const event = makeEvent();
  store.ingestFeedBatch("feed", makePage([event]));
  return { clock, database, store, event, item: event.items[0] };
}

test("schema migrations create durable tables and upgrade marker", () => {
  const { database } = storeWithEvent();
  assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 2);
  for (const table of ["settings", "feed_cursors", "feed_events", "feed_items", "purchase_attempts", "budget_reservations", "attempt_transitions", "local_logs"]) {
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).name, table);
  }
  database.close();
});

test("cursor, settings and attempts survive a close/reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-buy-agent-"));
  const filename = join(directory, "agent.sqlite");
  const clock = makeClock();
  const event = makeEvent();
  let db = new LocalDatabase(filename, { clock: clock.now });
  let store = new AgentStore(db, { clock: clock.now });
  store.ingestFeedBatch("feed", makePage([event], "persisted-cursor"));
  store.setSetting("execution_mode", "human_final");
  const attempt = store.createAttempt({
    itemKey: event.items[0].itemKey,
    eventId: event.eventId,
    searchId: event.searchId,
    itemId: event.items[0].itemId,
    mode: "human_final",
    market: event.market,
    currency: event.currency,
    itemPriceMinor: event.items[0].priceMinor,
  });
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.VALIDATED);
  store.reserveBudget({ attemptId: attempt.attemptId, amountMinor: 1234, currency: "GBP", maxDailyCount: 1 });
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.QUEUED);
  db.close();

  db = new LocalDatabase(filename, { clock: clock.now });
  store = new AgentStore(db, { clock: clock.now });
  assert.equal(store.getCursor("feed").cursor, "persisted-cursor");
  assert.equal(store.getSetting("execution_mode"), "human_final");
  assert.equal(store.getAttempt(attempt.attemptId).state, ATTEMPT_STATES.QUEUED);
  assert.equal(store.getReservation(attempt.attemptId).amountMinor, 1234);
  db.close();
  await rm(directory, { recursive: true, force: true });
});

test("budget reservations are counted by day and can be adjusted/released", () => {
  const { database, store, event, item, clock } = storeWithEvent();
  const attempt = store.createAttempt({
    itemKey: item.itemKey, eventId: event.eventId, searchId: event.searchId, itemId: item.itemId,
    mode: "dry_run", market: event.market, currency: event.currency, itemPriceMinor: item.priceMinor,
  });
  store.reserveBudget({ attemptId: attempt.attemptId, amountMinor: 1000, currency: "GBP", now: clock.now(), maxDailySpendMinor: 2000, maxDailyCount: 1 });
  assert.deepEqual(store.getDailyUsage("2026-08-23", "GBP"), { spendMinor: 1000, count: 1 });
  store.adjustReservation({ attemptId: attempt.attemptId, amountMinor: 1500, maxDailySpendMinor: 2000 });
  assert.equal(store.getDailyUsage("2026-08-23", "GBP").spendMinor, 1500);
  store.markReservation(attempt.attemptId, RESERVATION_STATES.RELEASED);
  assert.deepEqual(store.getDailyUsage("2026-08-23", "GBP"), { spendMinor: 0, count: 0 });
  database.close();
});

test("state transitions are audited and ambiguous states cannot be retried", () => {
  const { database, store, event, item } = storeWithEvent();
  const attempt = store.createAttempt({
    itemKey: item.itemKey, eventId: event.eventId, searchId: event.searchId, itemId: item.itemId,
    mode: "auto_submit", market: event.market, currency: event.currency, itemPriceMinor: item.priceMinor,
  });
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.VALIDATED);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.QUEUED);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.LISTING_CHECKED);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.CHECKOUT_OPENED);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.TOTAL_VERIFIED, { finalTotalMinor: 1500 });
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.PAYMENT_SUBMITTED);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.UNKNOWN, { reason: "restart" });
  assert.equal(store.getNextQueuedAttempt(), null);
  assert.throws(() => store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.QUEUED), /Invalid attempt transition/);
  assert.equal(store.listTransitions(attempt.attemptId).at(-1).toState, ATTEMPT_STATES.UNKNOWN);
  database.close();
});

test("restart recovery requeues pre-payment work and holds possible payments", () => {
  const { database, store, event, item } = storeWithEvent();
  const pre = store.createAttempt({
    itemKey: item.itemKey, eventId: event.eventId, searchId: event.searchId, itemId: item.itemId,
    mode: "auto_submit", market: event.market, currency: event.currency, itemPriceMinor: item.priceMinor,
  });
  store.transitionAttempt(pre.attemptId, ATTEMPT_STATES.VALIDATED);
  store.transitionAttempt(pre.attemptId, ATTEMPT_STATES.QUEUED);
  store.transitionAttempt(pre.attemptId, ATTEMPT_STATES.LISTING_CHECKED);
  store.reserveBudget({ attemptId: pre.attemptId, amountMinor: 1234, currency: "GBP", maxDailyCount: 3 });

  // A second item gives us an independent possible-payment attempt.
  const event2 = makeEvent({ eventId: "evt-2", itemId: "item-2" });
  store.ingestFeedBatch("feed", makePage([event2], "cursor-2"));
  const ambiguous = store.createAttempt({
    itemKey: event2.items[0].itemKey, eventId: event2.eventId, searchId: event2.searchId, itemId: event2.items[0].itemId,
    mode: "auto_submit", market: event2.market, currency: event2.currency, itemPriceMinor: event2.items[0].priceMinor,
  });
  store.transitionAttempt(ambiguous.attemptId, ATTEMPT_STATES.VALIDATED);
  store.transitionAttempt(ambiguous.attemptId, ATTEMPT_STATES.QUEUED);
  store.transitionAttempt(ambiguous.attemptId, ATTEMPT_STATES.LISTING_CHECKED);
  store.transitionAttempt(ambiguous.attemptId, ATTEMPT_STATES.CHECKOUT_OPENED);
  store.transitionAttempt(ambiguous.attemptId, ATTEMPT_STATES.TOTAL_VERIFIED, { finalTotalMinor: 1234 });
  store.transitionAttempt(ambiguous.attemptId, ATTEMPT_STATES.PAYMENT_SUBMITTED);
  store.reserveBudget({ attemptId: ambiguous.attemptId, amountMinor: 1234, currency: "GBP", maxDailyCount: 3 });

  const result = store.recoverAfterCrash();
  assert.deepEqual(result.recovered, [pre.attemptId]);
  assert.deepEqual(result.ambiguous, [ambiguous.attemptId]);
  assert.equal(store.getAttempt(pre.attemptId).state, ATTEMPT_STATES.QUEUED);
  assert.equal(store.getAttempt(ambiguous.attemptId).state, ATTEMPT_STATES.UNKNOWN);
  assert.equal(store.getReservation(ambiguous.attemptId).state, RESERVATION_STATES.HELD);
  assert.equal(store.getAttempt(pre.attemptId).recoveryCount, 1);
  database.close();
});

function eventWithItems({ eventId, detectedAt, searchId = "search-1", itemIds }) {
  const event = makeEvent({ eventId, detectedAt, searchId, itemId: itemIds[0] });
  event.items = itemIds.map((itemId, index) => ({
    ...event.items[0],
    itemId,
    itemKey: makeItemKey({ searchId, market: event.market, itemId }),
    title: `Item ${index + 1}`,
    raw: { id: itemId },
  }));
  event.raw = { ...event.raw, items: event.items.map((item) => item.raw) };
  return event;
}

function markAttempted(store, event, item) {
  return store.createAttempt({
    itemKey: item.itemKey,
    eventId: event.eventId,
    searchId: event.searchId,
    itemId: item.itemId,
    mode: "dry_run",
    state: ATTEMPT_STATES.SKIPPED,
    reason: "test_attempt",
    market: event.market,
    currency: event.currency,
    itemPriceMinor: item.priceMinor,
  });
}

test("startup query reconstructs only unattempted items, including partial events", () => {
  const clock = makeClock();
  const database = new LocalDatabase(":memory:", { clock: clock.now });
  const store = new AgentStore(database, { clock: clock.now });
  const early = eventWithItems({ eventId: "evt-early", detectedAt: "2026-08-23T11:58:00.000Z", itemIds: ["early-a", "early-b"] });
  const partial = eventWithItems({ eventId: "evt-partial", detectedAt: "2026-08-23T11:59:00.000Z", itemIds: ["partial-a", "partial-b"] });
  const full = eventWithItems({ eventId: "evt-full", detectedAt: "2026-08-23T12:00:00.000Z", itemIds: ["full-a", "full-b"] });
  store.ingestFeedBatch("feed", makePage([full, partial, early], "cursor-recovery"));

  // Simulate a crash after feed commit but before queue enqueue for early.
  markAttempted(store, partial, partial.items[0]);
  markAttempted(store, full, full.items[0]);
  markAttempted(store, full, full.items[1]);

  const recovered = store.listUnattemptedFeedEvents();
  assert.deepEqual(recovered.map((event) => event.eventId), ["evt-early", "evt-partial"]);
  assert.deepEqual(recovered[0].items.map((item) => item.itemId), ["early-a", "early-b"]);
  assert.deepEqual(recovered[1].items.map((item) => item.itemId), ["partial-b"]);
  assert.equal(recovered.some((event) => event.eventId === "evt-full"), false);

  const recoveredItems = store.listUnattemptedFeedItems();
  assert.deepEqual(recoveredItems.map((item) => item.itemId), ["early-a", "early-b", "partial-b"]);
  database.close();
});

test("unattempted event query has deterministic ordering, limits events, and filters search", () => {
  const clock = makeClock();
  const database = new LocalDatabase(":memory:", { clock: clock.now });
  const store = new AgentStore(database, { clock: clock.now });
  const later = eventWithItems({ eventId: "evt-z", detectedAt: "2026-08-23T12:00:00.000Z", itemIds: ["z-2", "z-1"] });
  const earlier = eventWithItems({ eventId: "evt-a", detectedAt: "2026-08-23T11:00:00.000Z", itemIds: ["a-2", "a-1"] });
  const otherSearch = eventWithItems({ eventId: "evt-other", detectedAt: "2026-08-23T10:00:00.000Z", searchId: "search-2", itemIds: ["other-1"] });
  store.ingestFeedBatch("feed", makePage([later, otherSearch, earlier], "cursor-order"));

  const first = store.listUnattemptedFeedEvents({ limit: 1 });
  assert.deepEqual(first.map((event) => event.eventId), ["evt-other"]);
  assert.deepEqual(first[0].items.map((item) => item.itemId), ["other-1"]);
  const filtered = store.listUnattemptedFeedEvents({ searchId: "search-1" });
  assert.deepEqual(filtered.map((event) => event.eventId), ["evt-a", "evt-z"]);
  assert.deepEqual(filtered[0].items.map((item) => item.itemId), ["a-1", "a-2"]);
  assert.deepEqual(filtered[1].items.map((item) => item.itemId), ["z-1", "z-2"]);
  assert.deepEqual(store.listUnattemptedEvents({ searchId: "search-2" }).map((event) => event.eventId), ["evt-other"]);
  database.close();
});

test("account binding permits same-account token rotation and quarantines other scopes", () => {
  const database = new LocalDatabase(":memory:");
  const store = new AgentStore(database);
  assert.deepEqual(store.bindAccountFingerprint("acct-a"), {
    ok: true,
    accountFingerprint: "acct-a",
    changed: true,
  });
  assert.deepEqual(store.bindAccountFingerprint("acct-a"), {
    ok: true,
    accountFingerprint: "acct-a",
    changed: false,
  });
  assert.equal(store.bindAccountFingerprint("acct-b").code, "account_scope_mismatch");
  assert.equal(store.bindAccountFingerprint("acct-a").code, "account_scope_quarantined");
  assert.equal(store.getSetting("account_fingerprint"), "acct-a");
  assert.equal(JSON.stringify(store.getSetting("account_scope_quarantine")).includes("acct-b"), false);
  database.close();
});

test("unbound persisted cursors are quarantined instead of assigned to a new account", () => {
  const database = new LocalDatabase(":memory:");
  const store = new AgentStore(database);
  store.setCursor("search-1", "cursor-1");
  const result = store.bindAccountFingerprint("acct-a");
  assert.equal(result.code, "account_scope_quarantined");
  assert.equal(store.getAccountFingerprint(), null);
  assert.equal(store.getCursor("search-1").cursor, "cursor-1");
  database.close();
});

test("retention prunes bounded terminal history but preserves active work, ambiguity, audit, reservations, and cursors", () => {
  const clock = makeClock();
  const database = new LocalDatabase(":memory:", { clock: clock.now });
  const store = new AgentStore(database, { clock: clock.now });
  const terminalEvent = eventWithItems({ eventId: "evt-terminal", itemIds: ["terminal"] });
  const activeEvent = eventWithItems({ eventId: "evt-active", itemIds: ["active"] });
  const ambiguousEvent = eventWithItems({ eventId: "evt-ambiguous", itemIds: ["ambiguous"] });
  store.ingestFeedBatch("search-1", makePage([terminalEvent, activeEvent, ambiguousEvent], "live-cursor"));

  const terminal = markAttempted(store, terminalEvent, terminalEvent.items[0]);
  const active = store.createAttempt({
    itemKey: activeEvent.items[0].itemKey, eventId: activeEvent.eventId, searchId: activeEvent.searchId,
    itemId: activeEvent.items[0].itemId, mode: "auto_submit", market: activeEvent.market,
    currency: activeEvent.currency, itemPriceMinor: activeEvent.items[0].priceMinor,
  });
  store.transitionAttempt(active.attemptId, ATTEMPT_STATES.VALIDATED);
  store.reserveBudget({ attemptId: active.attemptId, amountMinor: 1000, currency: "GBP" });
  store.transitionAttempt(active.attemptId, ATTEMPT_STATES.QUEUED);

  const ambiguous = store.createAttempt({
    itemKey: ambiguousEvent.items[0].itemKey, eventId: ambiguousEvent.eventId, searchId: ambiguousEvent.searchId,
    itemId: ambiguousEvent.items[0].itemId, mode: "auto_submit", state: ATTEMPT_STATES.UNKNOWN,
    market: ambiguousEvent.market, currency: ambiguousEvent.currency, itemPriceMinor: ambiguousEvent.items[0].priceMinor,
  });
  store.reserveBudget({ attemptId: ambiguous.attemptId, amountMinor: 1000, currency: "GBP" });
  store.markReservation(ambiguous.attemptId, RESERVATION_STATES.HELD);
  store.appendLog({ level: "info", event: "old-1" });
  store.appendLog({ level: "info", event: "old-2" });
  store.appendLog({ level: "info", event: "old-3" });
  database.prepare("UPDATE purchase_attempts SET updated_at = ? WHERE attempt_id = ?")
    .run("2020-01-01T00:00:00.000Z", terminal.attemptId);
  database.prepare("UPDATE feed_events SET inserted_at = ? WHERE event_id = ?")
    .run("2020-01-01T00:00:00.000Z", terminalEvent.eventId);
  database.prepare("UPDATE feed_items SET inserted_at = ? WHERE event_id = ?")
    .run("2020-01-01T00:00:00.000Z", terminalEvent.eventId);

  const result = store.cleanup({ attemptRetentionDays: 1, logRetentionDays: 1, maxLogRows: 2, batchSize: 50 });
  assert.equal(result.deletedAttempts, 1);
  assert.equal(store.getAttempt(terminal.attemptId), null);
  assert.equal(store.getAttempt(active.attemptId).state, ATTEMPT_STATES.QUEUED);
  assert.equal(store.getAttempt(ambiguous.attemptId).state, ATTEMPT_STATES.UNKNOWN);
  assert.equal(store.getReservation(active.attemptId).state, RESERVATION_STATES.RESERVED);
  assert.equal(store.getReservation(ambiguous.attemptId).state, RESERVATION_STATES.HELD);
  assert.ok(store.listTransitions(active.attemptId).length >= 2);
  assert.equal(store.getCursor("search-1").cursor, "live-cursor");
  assert.equal(store.listLogs(100).length, 2);
  database.close();
});

test("quota pressure makes log persistence degrade without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-buy-quota-"));
  const filename = join(directory, "agent.sqlite");
  const database = new LocalDatabase(filename);
  const store = new AgentStore(database, { maxDatabaseBytes: 1 });
  const result = store.appendLog({ level: "info", event: "quota-test" });
  assert.deepEqual(result, { persisted: false, degraded: true });
  assert.equal(store.storageStatus().state, "degraded");
  database.close();
  await rm(directory, { recursive: true, force: true });
});
