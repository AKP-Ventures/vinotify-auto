import assert from "node:assert/strict";
import test from "node:test";
import { FeedCursorExpiredError, VinotifyFeedClient } from "../../src/feed/client.js";
import { normalizeFeedPage, parseMoneyMinor } from "../../src/feed/normalize.js";
import { AgentStore } from "../../src/storage/repository.js";
import { LocalDatabase } from "../../src/storage/database.js";
import { FeedIngestor } from "../../src/feed/ingestor.js";
import { makeClock, makeEvent, makePage, NOW } from "../helpers.js";

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("money normalization uses integer minor units without floating point", () => {
  assert.equal(parseMoneyMinor("£12.34", "GBP"), 1234);
  assert.equal(parseMoneyMinor("1.234,56", "EUR"), 123456);
  assert.equal(parseMoneyMinor("¥1200", "JPY"), 1200);
  assert.equal(parseMoneyMinor("12.345", "GBP"), null);
});

test("Vinotify cursor client sends bearer auth and long-poll cursor", async () => {
  const calls = [];
  const client = new VinotifyFeedClient({
    baseUrl: "https://vinotify.example",
    searchId: 42,
    bearerToken: "secret-token",
    longPollSeconds: 17,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response({
        schema_version: 2,
        next_cursor: "cursor-2",
        events: [{
          schema_version: 2,
          event_id: "evt-1",
          search_id: 42,
          detected_at: NOW,
          market: "gb",
          currency: "gbp",
          items: [{ id: "item-1", title: "Jacket", price: "12.34", url: "https://vinted.example/items/1" }],
        }],
      });
    },
  });
  const page = await client.poll({ cursor: "cursor-1" });
  assert.equal(page.nextCursor, "cursor-2");
  assert.equal(page.events[0].items[0].priceMinor, 1234);
  assert.match(calls[0].url, /api\/v1\/integrations\/searches\/42\/webhook\/events/);
  assert.match(calls[0].url, /cursor=cursor-1/);
  assert.match(calls[0].url, /wait_seconds=17/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
});

test("empty 204 response preserves cursor", async () => {
  const client = new VinotifyFeedClient({
    baseUrl: "https://vinotify.example",
    searchId: "s",
    bearerToken: "token",
    fetchImpl: async () => response(null, 204),
  });
  const page = await client.poll({ cursor: "same" });
  assert.deepEqual(page, { schemaVersion: 2, events: [], invalidEvents: [], nextCursor: "same", cursorExpiresAt: null, hasMore: false });
});

test("cursor expiry is explicit and never silently reset", async () => {
  const client = new VinotifyFeedClient({
    baseUrl: "https://vinotify.example",
    searchId: "s",
    bearerToken: "token",
    fetchImpl: async () => response({ error_code: "cursor_expired" }, 410),
  });
  await assert.rejects(() => client.poll({ cursor: "old" }), (error) => {
    assert.ok(error instanceof FeedCursorExpiredError);
    assert.equal(error.code, "cursor_expired");
    return true;
  });
});

test("feed ingestor advances cursor atomically and deduplicates replay", async () => {
  const clock = makeClock();
  const db = new LocalDatabase(":memory:", { clock: clock.now });
  const store = new AgentStore(db, { clock: clock.now });
  store.setCursor("search-1", "cursor-0");
  const event = makeEvent();
  let calls = 0;
  const ingestor = new FeedIngestor({
    feedName: "search-1",
    store,
    client: { poll: async () => {
      calls += 1;
      return makePage([event], calls === 1 ? "cursor-1" : "cursor-2");
    } },
  });
  const first = await ingestor.pollOnce();
  const second = await ingestor.pollOnce();
  assert.equal(calls, 2);
  assert.deepEqual(first.result.insertedEvents, ["evt-1"]);
  assert.deepEqual(second.result.duplicateEvents, ["evt-1"]);
  assert.equal(store.getCursor("search-1").cursor, "cursor-2");
  assert.equal(store.listItemsForEvent("evt-1").length, 1);
  db.close();
});

test("an unseeded feed drains a multi-page snapshot before using the persisted cursor", async () => {
  const clock = makeClock();
  const db = new LocalDatabase(":memory:", { clock: clock.now });
  const store = new AgentStore(db, { clock: clock.now });
  const snapshotEvent = makeEvent({ eventId: "snapshot-1", itemId: "snapshot-item-1" });
  const snapshotPage = Array.from({ length: 50 }, (_, index) => makeEvent({
    eventId: `snapshot-${index + 2}`,
    itemId: `snapshot-item-${index + 2}`,
  }));
  const snapshotTail = makeEvent({ eventId: "snapshot-tail", itemId: "snapshot-item-tail" });
  const newEvent = makeEvent({ eventId: "new", itemId: "new-item" });
  const calls = [];
  const client = {
    poll: async ({ cursor }) => {
      calls.push(cursor);
      if (calls.length === 1) return makePage([snapshotEvent], "cursor-snapshot-1");
      if (calls.length === 2) return { ...makePage(snapshotPage, "cursor-snapshot-2"), hasMore: true };
      if (calls.length === 3) return makePage([snapshotTail], "cursor-snapshot-tail");
      if (calls.length === 4) return makePage([], "cursor-snapshot-tail");
      return makePage([newEvent], "cursor-new");
    },
  };

  const first = await new FeedIngestor({ client, store, feedName: "search-1" }).pollOnce();
  assert.equal(first.result.warmed, true);
  assert.equal(first.result.skippedEventCount, 1);
  assert.equal(first.result.warmStartComplete, false);
  assert.deepEqual(first.result.insertedItems, []);
  assert.equal(store.getEvent(snapshotEvent.eventId), null);
  assert.deepEqual(store.listUnattemptedFeedItems(), []);
  assert.equal(store.getCursor("search-1").cursor, "cursor-snapshot-1");
  assert.equal(store.getCursor("search-1").warmStartComplete, false);

  // A fresh ingestor models a process restart and must resume at the durable
  // warm-start cursor instead of opening another unseeded snapshot or
  // ingesting the remaining backfill.
  const restarted = new FeedIngestor({ client, store, feedName: "search-1" });
  const second = await restarted.pollOnce();
  assert.equal(calls[0], null);
  assert.equal(calls[1], "cursor-snapshot-1");
  assert.deepEqual(second.result.insertedItems, []);
  assert.equal(store.getEvent(snapshotPage[0].eventId), null);
  assert.equal(store.getCursor("search-1").cursor, "cursor-snapshot-2");
  assert.equal(store.getCursor("search-1").warmStartComplete, false);

  await restarted.pollOnce();
  await restarted.pollOnce();
  assert.equal(store.getEvent(snapshotTail.eventId), null);
  assert.equal(store.getCursor("search-1").warmStartComplete, true);

  const third = await restarted.pollOnce();
  assert.equal(calls[4], "cursor-snapshot-tail");
  assert.deepEqual(third.result.insertedItems, [newEvent.items[0].itemKey]);
  assert.equal(store.listUnattemptedFeedItems().length, 1);
  assert.equal(store.getCursor("search-1").cursor, "cursor-new");
  db.close();
});

test("page schema must be version 2", () => {
  assert.throws(() => normalizeFeedPage({ schema_version: 1, events: [] }), /Unsupported feed schema/);
});

test("an incomplete event is skipped without poisoning later cursor progress", () => {
  const page = normalizeFeedPage({
    schema_version: 2,
    next_cursor: "2-0",
    events: [
      {
        schema_version: 2,
        event_id: "bad",
        search_id: 42,
        detected_at: NOW,
        market: "",
        currency: "",
        items: [],
      },
      {
        schema_version: 2,
        event_id: "good",
        search_id: 42,
        detected_at: NOW,
        market: "uk",
        currency: "GBP",
        items: [{ id: "123", price: 12.5, url: "https://www.vinted.co.uk/items/123-coat" }],
      },
    ],
  });
  assert.deepEqual(page.events.map((event) => event.eventId), ["good"]);
  assert.equal(page.invalidEvents[0].eventId, "bad");
  assert.equal(page.nextCursor, "2-0");
});
