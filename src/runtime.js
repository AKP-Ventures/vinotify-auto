import { FeedCursorExpiredError } from "./feed/client.js";

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const complete = (callback) => (value) => {
      signal.removeEventListener("abort", aborted);
      callback(value);
    };
    const aborted = () => {
      clearTimeout(timer);
      complete(reject)(signal.reason ?? new Error("runtime_stopped"));
    };
    timer = setTimeout(complete(resolve), milliseconds);
    timer.unref?.();
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

function normalizeSearchIds(values) {
  if (!Array.isArray(values)) throw new TypeError("Search discovery must return an array");
  const ids = values.map((value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      value = value.search_id ?? value.searchId ?? value.id;
    }
    if (typeof value === "boolean" || value === null || value === undefined) return null;
    const number = typeof value === "number" ? value : Number(String(value).trim());
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  });
  if (ids.some((value) => value === null)) {
    throw new TypeError("Search discovery returned an invalid search ID");
  }
  return [...new Set(ids)].sort((left, right) => left - right);
}

function normalizeDiscoveryResult(value) {
  if (Array.isArray(value)) {
    return { accountFingerprint: null, searchIds: normalizeSearchIds(value), legacy: true };
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Search discovery must return an account scope and searches");
  }
  const rawFingerprint = value.accountFingerprint ?? value.account_fingerprint;
  const accountFingerprint = typeof rawFingerprint === "string" ? rawFingerprint.trim() : "";
  if (!accountFingerprint || accountFingerprint.length > 512) {
    throw new TypeError("Search discovery must return account_fingerprint");
  }
  const rawSearches = value.searchIds ?? value.search_ids ?? value.searches;
  return {
    accountFingerprint,
    searchIds: normalizeSearchIds(rawSearches),
    legacy: false,
  };
}

function isAuthorizationScopeError(error) {
  return error?.code === "unauthorized" || [401, 403].includes(Number(error?.status));
}

function isBlockingDiscoveryError(error) {
  return isAuthorizationScopeError(error)
    || error?.code === "schema_invalid"
    || Number(error?.status) === 409;
}

/** FIFO admission keeps a fast-returning feed from monopolising long-poll
 * slots while still allowing removed feeds to leave the queue immediately. */
class FairPollLimiter {
  constructor(maxConcurrent) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new TypeError("maxConcurrentFeeds must be a positive integer");
    }
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.waiters = [];
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("feed_stopped"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? new Error("feed_stopped"));
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.#pump();
    });
  }

  #pump() {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.onAbort();
        continue;
      }
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.#pump();
      });
    }
  }

  cancel() {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("feed_limiter_stopped"));
    }
  }
}

/**
 * Owns the feed loops and the serial purchase queue. Feed membership can be
 * refreshed while the process is running; each feed keeps its durable cursor
 * because its name remains `search-<id>` across discovery refreshes.
 */
export class AgentRuntime {
  constructor({
    store,
    queue,
    feeds = [],
    feedFactory = null,
    discoverSearchIds = null,
    discoveryRefreshSeconds = 60,
    maxConcurrentFeeds = 8,
    storageCleanupSeconds = 300,
    storageCleanupOptions = {},
    logger = null,
    controller = null,
  } = {}) {
    if (!store || !queue || !Array.isArray(feeds)) {
      throw new TypeError("store, queue, and feeds are required");
    }
    if (feeds.length === 0 && typeof discoverSearchIds !== "function") {
      throw new TypeError("at least one feed or a search discovery callback is required");
    }
    if (typeof discoverSearchIds === "function" && typeof feedFactory !== "function") {
      throw new TypeError("feedFactory is required when search discovery is enabled");
    }
    if (!Number.isSafeInteger(discoveryRefreshSeconds) || discoveryRefreshSeconds <= 0) {
      throw new TypeError("discoveryRefreshSeconds must be a positive integer");
    }
    if (!Number.isSafeInteger(maxConcurrentFeeds) || maxConcurrentFeeds <= 0 || maxConcurrentFeeds > 64) {
      throw new TypeError("maxConcurrentFeeds must be an integer between 1 and 64");
    }
    if (!Number.isSafeInteger(storageCleanupSeconds) || storageCleanupSeconds <= 0) {
      throw new TypeError("storageCleanupSeconds must be a positive integer");
    }

    this.store = store;
    this.queue = queue;
    this.feedFactory = feedFactory;
    this.discoverSearchIds = discoverSearchIds;
    this.discoveryRefreshMs = discoveryRefreshSeconds * 1000;
    this.pollLimiter = new FairPollLimiter(maxConcurrentFeeds);
    this.maxConcurrentFeeds = maxConcurrentFeeds;
    this.storageCleanupMs = storageCleanupSeconds * 1000;
    this.storageCleanupOptions = { ...storageCleanupOptions };
    this.logger = logger;
    this.controller = controller;
    this.abortController = null;
    this.tasks = [];
    this.feedTasks = new Map();
    this.discoveryTask = null;
    this.cleanupTask = null;
    this.pendingPromise = null;
    this.scopeReady = !discoverSearchIds;
    this.recoveryComplete = false;
    if (discoverSearchIds) this.queue.setSearchMembership?.({ searchIds: [], ready: false });
    this.feedMap = new Map();
    for (const feed of feeds) {
      const key = String(feed?.searchId ?? "").trim();
      if (!key) throw new TypeError("feed.searchId is required");
      if (this.feedMap.has(key)) throw new TypeError(`Duplicate feed search ID: ${key}`);
      this.feedMap.set(key, feed);
    }
    this.feeds = [...this.feedMap.values()];
    this.state = Object.fromEntries(this.feeds.map(({ searchId }) => [String(searchId), {
      state: "idle", lastSuccessAt: null, lastError: null,
    }]));
    this.discovery = {
      state: typeof discoverSearchIds === "function" ? "idle" : "disabled",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      searchCount: this.feeds.length,
      accountBound: false,
    };
  }

  snapshot() {
    const entries = Object.values(this.state);
    const discoveryDegraded = ["retrying", "blocked"].includes(this.discovery.state);
    return {
      running: Boolean(this.abortController && !this.abortController.signal.aborted),
      browser: this.controller?.isRunning ? "running" : "not_started",
      degraded: discoveryDegraded || entries.some((entry) => ["cursor_expired", "retrying"].includes(entry.state)),
      fatal: this.discovery.state === "blocked" || (entries.length > 0 && entries.every((entry) => entry.state === "cursor_expired")),
      discovery: structuredClone(this.discovery),
      feeds: structuredClone(this.state),
      storage: this.store.storageStatus?.() ?? { state: "unknown" },
      maxConcurrentFeeds: this.maxConcurrentFeeds,
    };
  }

  recover() {
    if (this.discoverSearchIds && !this.scopeReady) {
      const error = new Error("Account discovery must succeed before recovery");
      error.code = "account_scope_unavailable";
      throw error;
    }
    this.queue.disarm("startup_fail_closed");
    const recovery = this.queue.recoverAfterCrash();
    return recovery;
  }

  async processPersistedItems() {
    if (this.pendingPromise) return this.pendingPromise;
    this.pendingPromise = this.#processPersistedItems().finally(() => { this.pendingPromise = null; });
    return this.pendingPromise;
  }

  async #processPersistedItems() {
    if (this.discoverSearchIds && !this.scopeReady) {
      return { eventCount: 0, drain: { processed: [], blocked: true, reason: "account_scope_unavailable" } };
    }
    let eventCount = 0;
    while (true) {
      const events = this.store.listUnattemptedFeedEvents({ limit: 100 });
      if (events.length === 0) break;
      for (const event of events) {
        await this.queue.enqueueEvent(event);
        eventCount += 1;
      }
    }
    const drain = await this.queue.drain();
    return { eventCount, drain };
  }

  async start() {
    if (this.abortController && !this.abortController.signal.aborted) return this;
    this.abortController = new AbortController();
    this.tasks = [];
    if (this.discoverSearchIds) {
      const initial = await this.refreshSearches({ signal: this.abortController.signal });
      if (initial.ok) await this.#activateScope();
      this.discoveryTask = this.#discoveryLoop(this.abortController.signal);
    } else {
      await this.#activateScope();
    }
    this.cleanupTask = this.#cleanupLoop(this.abortController.signal);
    return this;
  }

  async #activateScope() {
    if (!this.scopeReady || this.recoveryComplete) return;
    this.recover();
    try {
      this.store.cleanup?.(this.storageCleanupOptions);
    } catch (error) {
      this.logger?.warn("storage_cleanup_failed", { reason: error?.code ?? "storage_cleanup_failed" });
    }
    await this.processPersistedItems();
    this.recoveryComplete = true;
    for (const feed of this.feeds) this.#startFeed(feed);
  }

  async #cleanupLoop(signal) {
    while (!signal.aborted) {
      try {
        await delay(this.storageCleanupMs, signal);
      } catch {
        return;
      }
      try {
        const result = this.store.cleanup?.(this.storageCleanupOptions);
        if (result?.deletedAttempts || result?.deletedLogs) {
          this.logger?.info("storage_cleanup_complete", {
            deletedAttempts: result.deletedAttempts,
            deletedLogs: result.deletedLogs,
          });
        }
      } catch (error) {
        this.logger?.warn("storage_cleanup_failed", { reason: error?.code ?? "storage_cleanup_failed" });
      }
    }
  }

  #stopScopedFeeds(reason) {
    for (const [key] of this.feedMap) {
      this.#stopFeed(key, reason);
      this.state[key] = {
        ...(this.state[key] ?? { lastSuccessAt: null }),
        state: "disabled",
        lastError: reason,
      };
    }
  }

  #disarm(reason) {
    try {
      this.queue.disarm?.(reason);
    } catch (error) {
      // A full/read-only database must not prevent the in-memory scope gate
      // from being cleared; the queue will remain blocked until persistence
      // recovers and discovery succeeds again.
      this.logger?.error("queue_disarm_failed", { reason: error?.code ?? "storage_error" });
    }
  }

  #blockScope(reason) {
    this.scopeReady = false;
    this.recoveryComplete = false;
    this.#disarm("account_scope_blocked");
    this.queue.clearSearchMembership?.();
    this.#stopScopedFeeds(reason);
    this.discovery = {
      ...this.discovery,
      state: "blocked",
      lastError: reason,
      accountBound: false,
    };
  }

  async #discoveryLoop(signal) {
    while (!signal.aborted) {
      try {
        await delay(this.discoveryRefreshMs, signal);
      } catch {
        return;
      }
      const refreshed = await this.refreshSearches({ signal });
      if (refreshed.ok) await this.#activateScope();
    }
  }

  /** Refresh account search membership without disturbing a failed snapshot. */
  async refreshSearches({ signal } = {}) {
    if (!this.discoverSearchIds) {
      return { ok: true, changed: false, searchIds: this.feeds.map((feed) => Number(feed.searchId)) };
    }
    const now = new Date().toISOString();
    this.discovery.lastAttemptAt = now;
    try {
      const discovered = await this.discoverSearchIds({ signal });
      const { accountFingerprint, searchIds, legacy } = normalizeDiscoveryResult(discovered);
      if (legacy) {
        // An ID-only response has no durable account identity. Do not even
        // create feeds here: polling would persist cursors/events into an
        // unbound database and make the eventual fingerprinted startup look
        // like an account mismatch. Retry feedlessly until identity arrives.
        this.scopeReady = false;
        this.recoveryComplete = false;
        this.#disarm("account_scope_unconfirmed");
        this.queue.clearSearchMembership?.();
        this.#stopScopedFeeds("account_scope_missing");
        this.discovery = {
          ...this.discovery,
          state: "retrying",
          lastError: "account_scope_missing",
          accountBound: false,
        };
        this.logger?.warn("search_discovery_failed", {
          reason: "account_scope_missing",
          retryInSeconds: this.discoveryRefreshMs / 1000,
        });
        return { ok: false, changed: false, error: "account_scope_missing" };
      }
      if (typeof this.store.bindAccountFingerprint === "function") {
        const binding = this.store.bindAccountFingerprint(accountFingerprint);
        if (!binding?.ok) {
          const error = new Error(binding?.reason ?? "account_scope_mismatch");
          error.code = binding?.code ?? "account_scope_mismatch";
          throw error;
        }
      }
      this.#applySearchIds(searchIds);
      this.scopeReady = true;
      this.queue.setSearchMembership?.({ accountFingerprint, searchIds, ready: true });
      this.discovery = {
        ...this.discovery,
        state: "healthy",
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        searchCount: searchIds.length,
        accountBound: Boolean(accountFingerprint),
      };
      return { ok: true, changed: true, searchIds };
    } catch (error) {
      if (signal?.aborted) return { ok: false, aborted: true };
      const reason = error?.code ?? "search_discovery_failed";
      if (reason === "account_scope_mismatch" || reason === "account_scope_missing" || reason === "account_scope_quarantined"
        || isBlockingDiscoveryError(error)) {
        this.#blockScope(reason);
      } else {
        this.discovery = { ...this.discovery, state: "retrying", lastError: reason };
      }
      // Keep the reason to a stable code only. In particular, never log the
      // bearer token or a server response that might echo request headers.
      this.logger?.warn("search_discovery_failed", { reason, retryInSeconds: this.discoveryRefreshMs / 1000 });
      return { ok: false, changed: false, error: reason };
    }
  }

  #applySearchIds(searchIds) {
    const previous = this.feedMap;
    const next = new Map();
    for (const searchId of searchIds) {
      const key = String(searchId);
      const existing = previous.get(key);
      next.set(key, existing ?? this.feedFactory(searchId));
    }

    for (const [key] of previous) {
      if (next.has(key)) continue;
      this.#stopFeed(key, "search_not_discovered");
      this.state[key] = {
        ...(this.state[key] ?? { lastSuccessAt: null }),
        state: "disabled",
        lastError: "search_not_discovered",
      };
    }
    this.feedMap = next;
    this.feeds = [...next.values()];
    this.discovery.searchCount = next.size;
    if (this.scopeReady && this.abortController && !this.abortController.signal.aborted) {
      for (const feed of this.feeds) this.#startFeed(feed);
    }
  }

  #startFeed(feed) {
    if (!this.abortController || this.abortController.signal.aborted || !this.scopeReady) return;
    const key = String(feed.searchId);
    const runningTask = this.feedTasks.get(key);
    if (runningTask && !runningTask.controller.signal.aborted) return;
    this.state[key] = {
      state: this.state[key]?.state === "disabled" ? "idle" : (this.state[key]?.state ?? "idle"),
      lastSuccessAt: this.state[key]?.lastSuccessAt ?? null,
      lastError: this.state[key]?.state === "disabled" ? null : (this.state[key]?.lastError ?? null),
    };
    const localController = new AbortController();
    const globalSignal = this.abortController.signal;
    const onGlobalAbort = () => localController.abort(globalSignal.reason ?? new Error("runtime_stopped"));
    if (globalSignal.aborted) onGlobalAbort();
    else globalSignal.addEventListener("abort", onGlobalAbort, { once: true });
    const taskInfo = { controller: localController, promise: null, feed };
    const promise = this.#feedLoop(feed, localController.signal).finally(() => {
      globalSignal.removeEventListener("abort", onGlobalAbort);
      if (this.feedTasks.get(key) === taskInfo) {
        this.feedTasks.delete(key);
        const current = this.feedMap.get(key);
        if (current && this.state[key]?.state !== "cursor_expired"
          && !globalSignal.aborted && this.scopeReady) {
          this.#startFeed(current);
        }
      }
    });
    taskInfo.promise = promise;
    this.feedTasks.set(key, taskInfo);
    this.tasks.push(promise);
  }

  #stopFeed(key, reason) {
    const task = this.feedTasks.get(key);
    if (task && !task.controller.signal.aborted) task.controller.abort(new Error(reason));
  }

  async #feedLoop(feed, signal) {
    const key = String(feed.searchId);
    let backoffMs = 1_000;
    while (!signal.aborted) {
      this.state[key] = { ...this.state[key], state: "polling", lastError: null };
      let release;
      try {
        release = await this.pollLimiter.acquire(signal);
        await feed.ingestor.pollOnce({ signal });
        release();
        release = null;
        await this.processPersistedItems();
        this.state[key] = {
          state: "healthy",
          lastSuccessAt: new Date().toISOString(),
          lastError: null,
        };
        backoffMs = 1_000;
      } catch (error) {
        release?.();
        if (signal.aborted) return;
        if (isAuthorizationScopeError(error)) {
          this.#blockScope(error?.code ?? "unauthorized");
          this.logger?.error("feed_scope_blocked", { searchId: key, reason: error?.code ?? "unauthorized" });
          return;
        }
        if (error instanceof FeedCursorExpiredError) {
          this.state[key] = {
            ...this.state[key],
            state: "cursor_expired",
            lastError: "cursor_expired_manual_resync_required",
          };
          this.logger?.error("feed_cursor_expired", { searchId: key });
          return;
        }
        this.state[key] = {
          ...this.state[key],
          state: "retrying",
          lastError: error?.code ?? error?.message ?? "feed_error",
        };
        this.logger?.warn("feed_poll_failed", {
          searchId: key,
          reason: error?.code ?? error?.message ?? "feed_error",
          retryInMs: backoffMs,
        });
        try {
          await delay(backoffMs, signal);
        } catch {
          return;
        }
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  async stop(reason = "runtime_stopped") {
    if (!this.abortController || this.abortController.signal.aborted) return;
    this.queue.disarm(reason);
    this.abortController.abort(new Error(reason));
    this.pollLimiter.cancel();
    const tasks = [...this.tasks, this.discoveryTask, this.cleanupTask].filter(Boolean);
    await Promise.allSettled(tasks);
    this.tasks = [];
    this.discoveryTask = null;
    this.cleanupTask = null;
    this.feedTasks.clear();
    this.scopeReady = !this.discoverSearchIds;
    this.recoveryComplete = false;
  }

  resetCursor(searchId) {
    const key = String(searchId);
    const feed = this.feedMap.get(key);
    if (!feed) throw new Error(`Unknown feed search ID: ${key}`);
    if (this.state[key]?.state !== "cursor_expired") {
      throw new Error("Only an expired feed cursor can be reset");
    }
    this.store.setCursor(feed.ingestor.feedName, "0-0", null);
    this.state[key] = { state: "idle", lastSuccessAt: null, lastError: null };
    if (this.abortController && !this.abortController.signal.aborted) this.#startFeed(feed);
    this.logger?.warn("feed_cursor_manually_reset", { searchId: key });
    return { searchId: key, cursor: "0-0", state: "idle" };
  }
}
