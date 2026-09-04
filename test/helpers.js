import { normalizeFeedEvent } from "../src/feed/normalize.js";

export const NOW = "2026-08-23T12:00:00.000Z";

export function makeEvent({
  eventId = "evt-1",
  searchId = "search-1",
  detectedAt = NOW,
  market = "GB",
  currency = "GBP",
  itemId = "item-1",
  price = "12.34",
  itemMarket = market,
  itemCurrency = currency,
  title = "Test jacket",
  url = "https://www.vinted.co.uk/items/item-1",
} = {}) {
  return normalizeFeedEvent({
    schema_version: 2,
    event_id: eventId,
    search_id: searchId,
    search_name: "Test search",
    detected_at: detectedAt,
    market,
    currency,
    items: [{
      id: itemId,
      title,
      price,
      market: itemMarket,
      currency: itemCurrency,
      url,
    }],
  }, { receivedAt: NOW });
}

export function makePage(events, nextCursor = "cursor-1") {
  return {
    schemaVersion: 2,
    events,
    nextCursor,
    cursorExpiresAt: "2026-08-24T12:00:00.000Z",
    hasMore: false,
  };
}

export function makeClock(iso = NOW) {
  let current = new Date(iso);
  return {
    now: () => new Date(current),
    set(value) { current = new Date(value); },
    advance(ms) { current = new Date(current.valueOf() + ms); },
  };
}
