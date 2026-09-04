import { FeedClientError, timeoutSignal } from "./client.js";

export const DEFAULT_DISCOVERY_PATH = "/api/v1/integrations/discovery/v2";
export const LEGACY_SEARCH_PATH = "/api/v1/integrations/searches";

function searchId(value) {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function searchEntries(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  for (const key of ["searches", "search_ids", "items", "results"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return null;
}

function accountFingerprintValue(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body.account_fingerprint ?? body.accountFingerprint;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  // The fingerprint is an opaque server-issued account scope identifier. It
  // is deliberately bounded and never derived from or replaced by the
  // bearer token on the client.
  return normalized && normalized.length <= 512 ? normalized : null;
}

function normalizeSearchEntries(body) {
  const entries = searchEntries(body);
  if (!entries) throw new TypeError("Search discovery response must contain an array of searches");
  const ids = [];
  for (const entry of entries) {
    const value = entry && typeof entry === "object"
      ? (entry.search_id ?? entry.searchId ?? entry.id)
      : entry;
    const id = searchId(value);
    if (id === null) throw new TypeError("Search discovery response contained an invalid search ID");
    ids.push(id);
  }
  return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * Accept the small response-shape variations used during the endpoint
 * rollout, while rejecting malformed data rather than silently dropping a
 * search from the account scope.
 */
export function normalizeDiscoveredSearchIds(body) {
  // Kept as a narrow compatibility helper for callers that only need the
  // list. Runtime account binding uses normalizeDiscoveredSearches instead.
  return normalizeSearchEntries(body);
}

/**
 * Normalize the account-scoped discovery contract. A fingerprint is required
 * here: accepting a bare search array in the runtime would make persisted
 * work indistinguishable across accounts after token rotation.
 */
export function normalizeDiscoveredSearches(body) {
  const accountFingerprint = accountFingerprintValue(body);
  if (!accountFingerprint) {
    throw new TypeError("Search discovery response must contain account_fingerprint");
  }
  return {
    accountFingerprint,
    searchIds: normalizeSearchEntries(body),
  };
}

export class SearchDiscoveryError extends FeedClientError {
  constructor(message, details = {}) {
    super(message, { ...details, code: details.code ?? "search_discovery_error", body: null });
    this.name = "SearchDiscoveryError";
  }
}

function normalizeSearchAllowlist(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("searchAllowlist must be a non-empty array");
  }
  const ids = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new TypeError("searchAllowlist must contain string search IDs");
    }
    const id = searchId(entry);
    if (id === null) throw new TypeError("searchAllowlist must contain positive search IDs");
    return String(id);
  });
  return [...new Set(ids)];
}

/**
 * Restrict an account-scoped discovery snapshot to the user's explicit local
 * selection. A missing configured ID is a blocking schema error: silently
 * treating it as a removed search would make a typo or revoked selection
 * indistinguishable from a valid empty scope.
 */
export function filterDiscoveredSearches(discovered, searchAllowlist) {
  if (!discovered || typeof discovered !== "object" || Array.isArray(discovered)
    || !Array.isArray(discovered.searchIds)) {
    throw new TypeError("discovered searches must contain an array of search IDs");
  }
  const allowedIds = normalizeSearchAllowlist(searchAllowlist);
  const discoveredIds = new Set(discovered.searchIds.map((value) => String(value)));
  if (allowedIds.some((id) => !discoveredIds.has(id))) {
    throw new SearchDiscoveryError("Configured search allowlist is not fully present in discovery response", {
      code: "schema_invalid",
    });
  }
  const allowed = new Set(allowedIds);
  return {
    ...discovered,
    searchIds: discovered.searchIds.filter((id) => allowed.has(String(id))),
  };
}

export class VinotifySearchDiscoveryClient {
  constructor({
    baseUrl,
    bearerToken,
    fetchImpl = globalThis.fetch,
    searchPath = null,
    legacySearchPath = null,
    searchAllowlist = null,
    requestTimeoutMs = 35_000,
  } = {}) {
    if (!baseUrl) throw new TypeError("baseUrl is required");
    if (!bearerToken || typeof bearerToken !== "string") throw new TypeError("bearerToken is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/, "");
    this.bearerToken = bearerToken;
    this.fetchImpl = fetchImpl;
    // `searchPath` was the original constructor option. Keep an explicit
    // override working for both helpers, while the hardened runtime defaults
    // to the versioned fingerprint-bearing endpoint and the no-option legacy
    // helper remains pinned to its old path.
    this.searchPath = searchPath ?? DEFAULT_DISCOVERY_PATH;
    this.legacySearchPath = legacySearchPath ?? (searchPath ?? LEGACY_SEARCH_PATH);
    this.searchAllowlist = searchAllowlist;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  buildUrl(path = this.searchPath) {
    return new URL(path, this.baseUrl);
  }

  buildLegacyUrl() {
    return this.buildUrl(this.legacySearchPath);
  }

  async listSearchIds({ signal } = {}) {
    const timeout = timeoutSignal(this.requestTimeoutMs, signal);
    let response;
    try {
      response = await this.fetchImpl(this.buildLegacyUrl(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.bearerToken}`,
        },
        signal: timeout?.signal ?? signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || timeout?.signal?.aborted) {
        throw new SearchDiscoveryError("Search discovery request aborted or timed out", {
          code: "request_aborted",
        });
      }
      throw new SearchDiscoveryError("Search discovery request failed", {
        code: "request_failed",
      });
    } finally {
      timeout?.dispose();
    }

    if (response.status === 204) return [];
    let body;
    try {
      body = await response.json();
    } catch {
      throw new SearchDiscoveryError("Search discovery response was not valid JSON", {
        code: "invalid_json",
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new SearchDiscoveryError(`Search discovery returned HTTP ${response.status}`, {
        code: response.status === 401 || response.status === 403 ? "unauthorized" : "http_error",
        status: response.status,
      });
    }
    try {
      return normalizeDiscoveredSearchIds(body);
    } catch (error) {
      throw new SearchDiscoveryError("Search discovery response failed schema validation", {
        code: "schema_invalid",
        status: response.status,
      });
    }
  }

  /**
   * Return the account identity and its current searches. This is the only
   * method the durable runtime uses; listSearchIds remains for older clients
   * that have not adopted account binding yet.
   */
  async listSearches({ signal, searchAllowlist = this.searchAllowlist } = {}) {
    const timeout = timeoutSignal(this.requestTimeoutMs, signal);
    let response;
    try {
      response = await this.fetchImpl(this.buildUrl(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.bearerToken}`,
        },
        signal: timeout?.signal ?? signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || timeout?.signal?.aborted) {
        throw new SearchDiscoveryError("Search discovery request aborted or timed out", {
          code: "request_aborted",
        });
      }
      throw new SearchDiscoveryError("Search discovery request failed", {
        code: "request_failed",
      });
    } finally {
      timeout?.dispose();
    }

    if (response.status === 204) {
      throw new SearchDiscoveryError("Search discovery response omitted account identity", {
        code: "schema_invalid",
        status: response.status,
      });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new SearchDiscoveryError("Search discovery response was not valid JSON", {
        code: "invalid_json",
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new SearchDiscoveryError(`Search discovery returned HTTP ${response.status}`, {
        code: response.status === 401 || response.status === 403 ? "unauthorized" : "http_error",
        status: response.status,
      });
    }
    try {
      return filterDiscoveredSearches(normalizeDiscoveredSearches(body), searchAllowlist);
    } catch {
      throw new SearchDiscoveryError("Search discovery response failed schema validation", {
        code: "schema_invalid",
        status: response.status,
      });
    }
  }
}

// Short aliases keep the public name easy to discover without breaking an
// early integration build that used the generic discovery-client spelling.
export const SearchDiscoveryClient = VinotifySearchDiscoveryClient;
