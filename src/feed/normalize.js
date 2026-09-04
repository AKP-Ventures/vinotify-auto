import { createHash } from "node:crypto";
import { makeItemKey } from "../storage/repository.js";
import { normalizeIdentifier } from "../core/types.js";

const CURRENCY_DECIMALS = Object.freeze({
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, JPY: 0, KMF: 0, KRW: 0, MGA: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
});

function decimalPlaces(currency) {
  return CURRENCY_DECIMALS[String(currency).toUpperCase()] ?? 2;
}

function decimalToMinor(value, currency) {
  const decimals = decimalPlaces(currency);
  const text = String(value).trim().replace(/[^\d.,+-]/g, "");
  if (!text) return null;
  let normalized = text;
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    // The final punctuation is treated as the decimal separator; the other
    // one is a thousands separator.
    const separator = comma > dot ? "," : ".";
    const thousands = separator === "," ? "." : ",";
    normalized = normalized.replaceAll(thousands, "").replace(separator, ".");
  } else if (comma >= 0) {
    normalized = normalized.replace(",", ".");
  }
  const match = normalized.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = BigInt(match[2]);
  const fraction = (match[3] ?? "").padEnd(decimals, "0").slice(0, decimals);
  // Reject non-zero precision beyond the currency's supported decimals rather
  // than silently rounding a purchase amount.
  if ((match[3] ?? "").length > decimals && /[1-9]/.test((match[3] ?? "").slice(decimals))) {
    return null;
  }
  const minor = whole * (10n ** BigInt(decimals)) + BigInt(fraction || "0");
  const signed = BigInt(sign) * minor;
  if (signed < 0n || signed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(signed);
}

export function parseMoneyMinor(value, currency) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    if (value.amount_minor !== undefined) return parseMoneyMinor(value.amount_minor, currency);
    if (value.amountMinor !== undefined) return parseMoneyMinor(value.amountMinor, currency);
    if (value.amount !== undefined) return parseMoneyMinor(value.amount, value.currency ?? currency);
  }
  // Explicit *_minor values are already integer units. Callers should use
  // parseMoneyMinor(value, currency) only for major-unit values.
  if (typeof value === "number" && Number.isSafeInteger(value) && value < 0) return null;
  return decimalToMinor(value, currency);
}

function stableFallbackId(raw) {
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 32);
}

export function normalizeItem(raw, event) {
  if (!raw || typeof raw !== "object") throw new TypeError("Feed item must be an object");
  const itemId = normalizeIdentifier(raw.item_id ?? raw.itemId ?? raw.id, "item_id");
  const market = String(raw.market ?? event.market ?? "").trim().toUpperCase();
  const currency = String(raw.currency ?? event.currency ?? "").trim().toUpperCase();
  const url = String(raw.url ?? raw.item_url ?? raw.itemUrl ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new TypeError(`Feed item ${itemId} has an invalid URL`);
  const priceValue = raw.price_minor !== undefined ? raw.price_minor : raw.priceMinor !== undefined
    ? raw.priceMinor : raw.price;
  const priceMinor = raw.price_minor !== undefined || raw.priceMinor !== undefined
    ? (Number.isSafeInteger(Number(priceValue)) && Number(priceValue) >= 0 ? Number(priceValue) : null)
    : parseMoneyMinor(priceValue, currency);
  if (priceMinor === null) throw new TypeError(`Feed item ${itemId} has an invalid price`);
  const title = String(raw.title ?? "").trim();
  const item = {
    itemKey: makeItemKey({ searchId: event.searchId, market, itemId }),
    itemId,
    market,
    currency,
    url,
    title,
    priceMinor,
    raw,
  };
  return item;
}

export function normalizeFeedEvent(raw, { receivedAt = new Date().toISOString(), schemaVersion = 2 } = {}) {
  if (!raw || typeof raw !== "object") throw new TypeError("Feed event must be an object");
  const eventSchemaVersion = Number(raw.schema_version ?? raw.schemaVersion ?? schemaVersion);
  if (eventSchemaVersion !== 2) throw new TypeError(`Unsupported feed event schema version: ${eventSchemaVersion}`);
  const eventId = normalizeIdentifier(raw.event_id ?? raw.eventId ?? raw.id, "event_id");
  const searchId = normalizeIdentifier(raw.search_id ?? raw.searchId, "search_id");
  const searchName = raw.search_name ?? raw.searchName ?? null;
  const detectedAt = raw.detected_at ?? raw.detectedAt ?? raw.created_at ?? raw.createdAt;
  if (!detectedAt || Number.isNaN(new Date(detectedAt).valueOf())) {
    throw new TypeError(`Feed event ${eventId} has an invalid detected_at`);
  }
  const market = String(raw.market ?? raw.country ?? "").trim().toUpperCase();
  const currency = String(raw.currency ?? "").trim().toUpperCase();
  if (!market || !currency) throw new TypeError(`Feed event ${eventId} is missing market/currency`);
  const items = Array.isArray(raw.items) ? raw.items.map((item) => normalizeItem(item, { searchId, market, currency })) : [];
  return {
    eventId,
    schemaVersion: eventSchemaVersion,
    searchId,
    searchName: searchName === null ? null : String(searchName),
    detectedAt: new Date(detectedAt).toISOString(),
    receivedAt: new Date(receivedAt).toISOString(),
    market,
    currency,
    items,
    raw,
    fallbackId: stableFallbackId(raw),
  };
}

export function normalizeFeedPage(payload, { receivedAt = new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== "object") throw new TypeError("Feed response must be an object");
  const schemaVersion = Number(payload.schema_version ?? payload.schemaVersion);
  if (schemaVersion !== 2) throw new TypeError(`Unsupported feed schema version: ${schemaVersion}`);
  const events = [];
  const invalidEvents = [];
  for (const rawEvent of Array.isArray(payload.events) ? payload.events : []) {
    try {
      events.push(normalizeFeedEvent(rawEvent, { receivedAt, schemaVersion }));
    } catch (error) {
      // A single legacy/incomplete stream entry must not poison the cursor and
      // prevent every later valid item from being consumed. It is deliberately
      // omitted (never purchased) and surfaced for local audit logging.
      invalidEvents.push({
        eventId: rawEvent?.event_id ?? rawEvent?.eventId ?? rawEvent?.id ?? null,
        reason: error.message,
      });
    }
  }
  const nextCursor = payload.next_cursor ?? payload.nextCursor ?? payload.cursor ?? null;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new TypeError("next_cursor must be a string or null");
  }
  const cursorExpiresAt = payload.cursor_expires_at ?? payload.cursorExpiresAt ?? null;
  if (cursorExpiresAt !== null && Number.isNaN(new Date(cursorExpiresAt).valueOf())) {
    throw new TypeError("cursor_expires_at must be an ISO timestamp or null");
  }
  return {
    schemaVersion,
    events,
    invalidEvents,
    nextCursor,
    cursorExpiresAt: cursorExpiresAt === null ? null : new Date(cursorExpiresAt).toISOString(),
    hasMore: Boolean(payload.has_more ?? payload.hasMore ?? false),
  };
}
