export class FeedIngestor {
  constructor({ client, store, feedName = "default", logger = null } = {}) {
    if (!client || typeof client.poll !== "function") throw new TypeError("client.poll is required");
    if (!store || typeof store.getCursor !== "function" || typeof store.setCursor !== "function"
      || typeof store.ingestFeedBatch !== "function") {
      throw new TypeError("A compatible AgentStore is required");
    }
    this.client = client;
    this.store = store;
    this.feedName = feedName;
    this.logger = logger;
  }

  async pollOnce({ signal } = {}) {
    const saved = this.store.getCursor(this.feedName);
    const warming = saved === null || saved.warmStartComplete === false;
    const page = await this.client.poll({ cursor: saved?.cursor ?? null, signal });
    const nextCursor = page.nextCursor ?? saved?.cursor ?? null;
    if (page.events.length > 0 && saved !== null && nextCursor === saved.cursor) {
      const error = new Error("Feed returned events without advancing its cursor");
      error.code = "cursor_stalled";
      throw error;
    }
    if (warming) {
      // An unseeded stream starts at 0-0 and returns the current historical
      // snapshot. Establish the durable cursor without persisting those
      // listings; remain in warm-start mode until a page is empty and has no
      // continuation so a multi-page/backfilled stream cannot flood the queue.
      const warmStartComplete = page.events.length === 0 && !page.hasMore;
      this.store.setCursor(this.feedName, nextCursor, page.cursorExpiresAt ?? saved?.cursorExpiresAt ?? null, {
        warmStartComplete,
      });
      const result = {
        insertedEvents: [],
        duplicateEvents: [],
        insertedItems: [],
        duplicateItems: [],
        nextCursor,
        warmed: true,
        skippedEventCount: page.events.length,
        warmStartComplete,
      };
      this.logger?.info("feed_warm_progress", {
        feedName: this.feedName,
        cursor: nextCursor,
        skippedEventCount: page.events.length,
        invalidEventCount: page.invalidEvents?.length ?? 0,
        warmStartComplete,
      });
      return { page, result };
    }
    const result = this.store.ingestFeedBatch(this.feedName, {
      ...page,
      nextCursor,
      cursorExpiresAt: page.cursorExpiresAt ?? saved?.cursorExpiresAt ?? null,
    });
    this.logger?.info("feed_page_ingested", {
      feedName: this.feedName,
      cursor: nextCursor,
      eventCount: page.events.length,
      invalidEventCount: page.invalidEvents?.length ?? 0,
      insertedEventCount: result.insertedEvents.length,
      insertedItemCount: result.insertedItems.length,
    });
    return { page, result };
  }
}
