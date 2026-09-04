import assert from "node:assert/strict";
import test from "node:test";

import {
  SearchDiscoveryError,
  VinotifySearchDiscoveryClient,
  filterDiscoveredSearches,
  normalizeDiscoveredSearches,
  normalizeDiscoveredSearchIds,
} from "../../src/feed/discovery.js";

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("search discovery uses bearer auth and normalizes the account search list", async () => {
  const calls = [];
  const client = new VinotifySearchDiscoveryClient({
    baseUrl: "https://vinotify.example",
    bearerToken: "secret-token",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response({ searches: [{ id: 42 }, { search_id: 7 }, { id: 42 }] });
    },
  });
  assert.deepEqual(await client.listSearchIds(), [7, 42]);
  assert.equal(calls[0].url, "https://vinotify.example/api/v1/integrations/searches");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
});

test("an unavailable discovery endpoint fails without exposing response data", async () => {
  const client = new VinotifySearchDiscoveryClient({
    baseUrl: "https://vinotify.example",
    bearerToken: "secret-token",
    fetchImpl: async () => response({ detail: "Bearer secret-token must not leak" }, 503),
  });
  await assert.rejects(() => client.listSearchIds(), (error) => {
    assert.ok(error instanceof SearchDiscoveryError);
    assert.equal(error.code, "http_error");
    assert.equal(error.body, null);
    assert.equal(error.message.includes("secret-token"), false);
    return true;
  });
});

test("malformed discovery data is rejected instead of dropping a search", () => {
  assert.throws(
    () => normalizeDiscoveredSearchIds({ searches: [{ id: 1 }, { name: "missing-id" }] }),
    /invalid search ID/,
  );
});

test("account-scoped discovery requires an opaque fingerprint", async () => {
  assert.deepEqual(
    normalizeDiscoveredSearches({ account_fingerprint: " acct-hash ", searches: [{ id: 2 }, { id: 1 }] }),
    { accountFingerprint: "acct-hash", searchIds: [1, 2] },
  );
  assert.throws(
    () => normalizeDiscoveredSearches({ searches: [{ id: 1 }] }),
    /account_fingerprint/,
  );
  const client = new VinotifySearchDiscoveryClient({
    baseUrl: "https://vinotify.example",
    bearerToken: "secret-token",
    searchAllowlist: ["1"],
    fetchImpl: async () => response({ searches: [{ id: 1 }] }),
  });
  await assert.rejects(() => client.listSearches(), (error) => {
    assert.equal(error.code, "schema_invalid");
    return true;
  });
});

test("account-scoped discovery returns identity separately from legacy ID helper", async () => {
  const calls = [];
  const client = new VinotifySearchDiscoveryClient({
    baseUrl: "https://vinotify.example",
    bearerToken: "secret-token",
    searchAllowlist: ["42"],
    fetchImpl: async (url) => {
      calls.push(String(url));
      return String(url).endsWith("/searches")
        ? response([{ id: 42 }])
        : response({ account_fingerprint: "acct-1", searches: [{ id: 42 }] });
    },
  });
  assert.deepEqual(await client.listSearches(), { accountFingerprint: "acct-1", searchIds: [42] });
  assert.deepEqual(await client.listSearchIds(), [42]);
  assert.deepEqual(calls, [
    "https://vinotify.example/api/v1/integrations/discovery/v2",
    "https://vinotify.example/api/v1/integrations/searches",
  ]);
});

test("hardened discovery path can be explicitly overridden without changing legacy helper semantics", async () => {
  const calls = [];
  const client = new VinotifySearchDiscoveryClient({
    baseUrl: "https://vinotify.example",
    bearerToken: "secret-token",
    searchAllowlist: ["8"],
    searchPath: "/api/v1/integrations/discovery/custom",
    legacySearchPath: "/api/v1/integrations/searches/legacy-custom",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return String(url).endsWith("legacy-custom")
        ? response([{ id: 7 }])
        : response({ account_fingerprint: "acct-1", searches: [{ id: 8 }] });
    },
  });
  assert.deepEqual(await client.listSearches(), { accountFingerprint: "acct-1", searchIds: [8] });
  assert.deepEqual(await client.listSearchIds(), [7]);
  assert.deepEqual(calls, [
    "https://vinotify.example/api/v1/integrations/discovery/custom",
    "https://vinotify.example/api/v1/integrations/searches/legacy-custom",
  ]);
});

test("discovery filters extra searches and preserves the account fingerprint", () => {
  assert.deepEqual(
    filterDiscoveredSearches(
      { accountFingerprint: "acct-1", searchIds: [7, 42, 99] },
      ["42", "7"],
    ),
    { accountFingerprint: "acct-1", searchIds: [7, 42] },
  );
});

test("a configured search missing from discovery is a stable blocking schema error", () => {
  assert.throws(
    () => filterDiscoveredSearches(
      { accountFingerprint: "acct-1", searchIds: [7] },
      ["7", "42"],
    ),
    (error) => {
      assert.ok(error instanceof SearchDiscoveryError);
      assert.equal(error.code, "schema_invalid");
      assert.equal(error.message, "Configured search allowlist is not fully present in discovery response");
      return true;
    },
  );
});

test("account-scoped discovery fails closed when no allowlist is supplied", async () => {
  const client = new VinotifySearchDiscoveryClient({
    baseUrl: "https://vinotify.example",
    bearerToken: "secret-token",
    fetchImpl: async () => response({ account_fingerprint: "acct-1", searches: [{ id: 1 }] }),
  });
  await assert.rejects(() => client.listSearches(), (error) => {
    assert.ok(error instanceof SearchDiscoveryError);
    assert.equal(error.code, "schema_invalid");
    return true;
  });
});
