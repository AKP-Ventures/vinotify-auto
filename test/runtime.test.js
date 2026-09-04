import assert from "node:assert/strict";
import test from "node:test";

import { AgentRuntime } from "../src/runtime.js";

test("expired cursors require explicit reset and return to the retained stream start", () => {
  const calls = [];
  const runtime = new AgentRuntime({
    store: { setCursor: (...values) => calls.push(values) },
    queue: {},
    feeds: [{ searchId: 42, ingestor: { feedName: "search-42" } }],
  });

  assert.throws(() => runtime.resetCursor(42), /expired/);
  runtime.state["42"] = {
    state: "cursor_expired",
    lastSuccessAt: null,
    lastError: "cursor_expired_manual_resync_required",
  };
  assert.deepEqual(runtime.resetCursor(42), {
    searchId: "42",
    cursor: "0-0",
    state: "idle",
  });
  assert.deepEqual(calls, [["search-42", "0-0", null]]);
});

test("discovery adds future searches while preserving existing feed instances", async () => {
  const store = { setCursor() {} };
  const queue = { recoverAfterCrash() {}, disarm() {} };
  const feedById = new Map();
  let discovered = { account_fingerprint: "acct-1", searches: [1] };
  const runtime = new AgentRuntime({
    store,
    queue,
    feeds: [],
    feedFactory: (searchId) => {
      const feed = { searchId, ingestor: { feedName: `search-${searchId}` } };
      feedById.set(String(searchId), feed);
      return feed;
    },
    discoverSearchIds: async () => discovered,
  });

  await runtime.refreshSearches();
  const first = runtime.feeds[0];
  assert.deepEqual(runtime.feeds.map((feed) => feed.searchId), [1]);
  discovered = { account_fingerprint: "acct-1", searches: [1, 2] };
  await runtime.refreshSearches();
  assert.deepEqual(runtime.feeds.map((feed) => feed.searchId), [1, 2]);
  assert.equal(runtime.feeds[0], first);
  assert.equal(runtime.feeds[1], feedById.get("2"));
  assert.equal(runtime.feeds[0].ingestor.feedName, "search-1");
});

test("failed discovery retains the last known search set", async () => {
  const queue = { recoverAfterCrash() {}, disarm() {} };
  const runtime = new AgentRuntime({
    store: { setCursor() {} },
    queue,
    feeds: [],
    feedFactory: (searchId) => ({ searchId, ingestor: { feedName: `search-${searchId}` } }),
    discoverSearchIds: async () => { throw Object.assign(new Error("offline"), { code: "request_failed" }); },
  });

  const result = await runtime.refreshSearches();
  assert.equal(result.ok, false);
  assert.deepEqual(runtime.feeds, []);
  assert.equal(runtime.snapshot().discovery.state, "retrying");
});

test("legacy ID-only discovery stays feedless until identity is available", async () => {
  let feedFactoryCalls = 0;
  let pollCalls = 0;
  const queue = {
    setSearchMembership() {},
    clearSearchMembership() {},
    disarm() {},
    recoverAfterCrash() { throw new Error("recovery must not run"); },
  };
  const store = {
    bindAccountFingerprint() { throw new Error("identity binding must not run for legacy data"); },
    listUnattemptedFeedEvents() { throw new Error("persisted work must not be read"); },
    cleanup() {},
  };
  const runtime = new AgentRuntime({
    store,
    queue,
    feeds: [],
    feedFactory: (searchId) => {
      feedFactoryCalls += 1;
      return { searchId, ingestor: { feedName: `search-${searchId}`, async pollOnce() { pollCalls += 1; } } };
    },
    discoverSearchIds: async () => [99],
    discoveryRefreshSeconds: 3_600,
    storageCleanupSeconds: 3_600,
  });
  await runtime.start();
  assert.equal(feedFactoryCalls, 0);
  assert.equal(pollCalls, 0);
  assert.equal(runtime.snapshot().discovery.lastError, "account_scope_missing");
  await runtime.stop();
});

test("authorization and schema discovery failures revoke a previously healthy scope", async () => {
  let response = { account_fingerprint: "acct-1", searches: [1] };
  const disarms = [];
  let clears = 0;
  const queue = {
    setSearchMembership() {},
    clearSearchMembership() { clears += 1; },
    disarm(reason) { disarms.push(reason); },
  };
  const store = {
    bindAccountFingerprint() { return { ok: true }; },
  };
  const runtime = new AgentRuntime({
    store,
    queue,
    feeds: [],
    feedFactory: (searchId) => ({ searchId, ingestor: { feedName: `search-${searchId}` } }),
    discoverSearchIds: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
  });
  await runtime.refreshSearches();
  assert.equal(runtime.snapshot().discovery.state, "healthy");

  response = Object.assign(new Error("revoked"), { code: "unauthorized", status: 401 });
  assert.equal((await runtime.refreshSearches()).ok, false);
  assert.equal(runtime.snapshot().discovery.state, "blocked");
  assert.equal(runtime.snapshot().discovery.lastError, "unauthorized");

  response = { account_fingerprint: "acct-1", searches: [1] };
  await runtime.refreshSearches();
  assert.equal(runtime.snapshot().discovery.state, "healthy");
  response = Object.assign(new Error("rollback"), { code: "schema_invalid", status: 200 });
  assert.equal((await runtime.refreshSearches()).ok, false);
  assert.equal(runtime.snapshot().discovery.state, "blocked");
  assert.ok(disarms.length >= 2);
  assert.ok(clears >= 2);
});

test("a feed 401 revokes the whole account scope immediately", async () => {
  const disarms = [];
  let clears = 0;
  const queue = {
    setSearchMembership() {},
    clearSearchMembership() { clears += 1; },
    disarm(reason) { disarms.push(reason); },
    recoverAfterCrash() { return {}; },
    async drain() { return {}; },
  };
  const store = {
    bindAccountFingerprint() { return { ok: true }; },
    listUnattemptedFeedEvents() { return []; },
    cleanup() {},
  };
  const runtime = new AgentRuntime({
    store,
    queue,
    feeds: [],
    feedFactory: (searchId) => ({
      searchId,
      ingestor: {
        feedName: `search-${searchId}`,
        async pollOnce() { throw Object.assign(new Error("revoked"), { code: "unauthorized", status: 401 }); },
      },
    }),
    discoverSearchIds: async () => ({ account_fingerprint: "acct-1", searches: [1] }),
    discoveryRefreshSeconds: 3_600,
    storageCleanupSeconds: 3_600,
  });
  await runtime.start();
  for (let attempt = 0; attempt < 20 && runtime.snapshot().discovery.state !== "blocked"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.snapshot().discovery.state, "blocked");
  assert.ok(disarms.includes("account_scope_blocked"));
  assert.ok(clears >= 1);
  await runtime.stop();
});

test("startup waits for account identity before recovery or persisted drain", async () => {
  const calls = [];
  let releaseDiscovery;
  const discovery = new Promise((resolve) => { releaseDiscovery = resolve; });
  const store = {
    bindAccountFingerprint(value) { calls.push(["bind", value]); return { ok: true }; },
    listUnattemptedFeedEvents() { calls.push("list"); return []; },
    cleanup() { calls.push("cleanup"); },
  };
  const queue = {
    setSearchMembership(value) { calls.push(["scope", value.ready]); },
    recoverAfterCrash() { calls.push("recover"); return {}; },
    disarm() { calls.push("disarm"); },
    async drain() { calls.push("drain"); return {}; },
  };
  const runtime = new AgentRuntime({
    store,
    queue,
    feeds: [],
    feedFactory: (searchId) => ({ searchId, ingestor: { feedName: `search-${searchId}`, async pollOnce({ signal }) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    } } }),
    discoverSearchIds: async () => discovery,
    discoveryRefreshSeconds: 3_600,
    storageCleanupSeconds: 3_600,
  });
  const started = runtime.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("recover"), false);
  releaseDiscovery({ account_fingerprint: "acct-1", searches: [] });
  await started;
  assert.ok(calls.indexOf("recover") > calls.indexOf("bind"));
  assert.ok(calls.indexOf("drain") > calls.indexOf("recover"));
  await runtime.stop();
});

test("feed polling is bounded and fair across discovered feeds", async () => {
  const counts = new Map();
  let active = 0;
  let maximum = 0;
  const queue = {
    recoverAfterCrash() { return {}; },
    disarm() {},
    async drain() { return {}; },
  };
  const store = { listUnattemptedFeedEvents() { return []; } };
  const feeds = [1, 2, 3, 4, 5].map((searchId) => ({
    searchId,
    ingestor: {
      feedName: `search-${searchId}`,
      async pollOnce({ signal }) {
        counts.set(searchId, (counts.get(searchId) ?? 0) + 1);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 2);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        active -= 1;
      },
    },
  }));
  const runtime = new AgentRuntime({
    store,
    queue,
    feeds,
    maxConcurrentFeeds: 2,
    storageCleanupSeconds: 3_600,
  });
  await runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await runtime.stop();
  assert.ok(maximum <= 2);
  for (const searchId of [1, 2, 3, 4, 5]) assert.ok((counts.get(searchId) ?? 0) > 0, `search ${searchId} starved`);
});
