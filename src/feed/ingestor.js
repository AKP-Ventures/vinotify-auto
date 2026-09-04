export class FeedIngestor {
  constructor({ client, store, feedName = "default", logger = null } = {}) {
    if (!client || typeof client.poll !== "function") throw new TypeError("client.poll is required");
    if (!store || typeof store.getCursor !== "function" || typeof store.ingestFeedBatch !== "function") {
      throw new TypeError("A compatible AgentStore is required");
    }
    this.client = client;
    this.store = store;
    this.feedName = feedName;
    this.logger = logger;
  }

  async pollOnce({ signal } = {}) {
    const saved = this.store.getCursor(this.feedName);
    const page = await this.client.poll({ cursor: saved?.cursor ?? null, signal });
    const nextCursor = page.nextCursor ?? saved?.cursor ?? null;
    if (page.events.length > 0 && saved?.cursor && nextCursor === saved.cursor) {
      const error = new Error("Feed returned events without advancing its cursor");
      error.code = "cursor_stalled";
      throw error;
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
