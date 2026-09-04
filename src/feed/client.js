import { normalizeFeedPage } from "./normalize.js";

export class FeedClientError extends Error {
  constructor(message, { code = "feed_error", status = null, body = null } = {}) {
    super(message);
    this.name = "FeedClientError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export class FeedCursorExpiredError extends FeedClientError {
  constructor(message = "The feed cursor has expired", details = {}) {
    super(message, { ...details, code: "cursor_expired" });
    this.name = "FeedCursorExpiredError";
  }
}

export function timeoutSignal(timeoutMs, externalSignal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return externalSignal;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("feed_request_timeout")), timeoutMs);
  timer.unref?.();
  if (!externalSignal) return { signal: controller.signal, dispose: () => clearTimeout(timer) };
  const onAbort = () => controller.abort(externalSignal.reason ?? new Error("feed_request_aborted"));
  if (externalSignal.aborted) onAbort();
  else externalSignal.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      externalSignal.removeEventListener("abort", onAbort);
    },
  };
}

export class VinotifyFeedClient {
  constructor({
    baseUrl,
    searchId,
    bearerToken,
    fetchImpl = globalThis.fetch,
    feedPath = null,
    longPollSeconds = 25,
    requestTimeoutMs = 35_000,
    clock = () => new Date(),
  } = {}) {
    if (!baseUrl) throw new TypeError("baseUrl is required");
    if (searchId === undefined || searchId === null || String(searchId).trim() === "") {
      throw new TypeError("searchId is required");
    }
    if (!bearerToken || typeof bearerToken !== "string") throw new TypeError("bearerToken is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isSafeInteger(longPollSeconds) || longPollSeconds < 0 || longPollSeconds > 120) {
      throw new TypeError("longPollSeconds must be an integer between 0 and 120");
    }
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/, "");
    this.searchId = String(searchId);
    this.bearerToken = bearerToken;
    this.fetchImpl = fetchImpl;
    this.feedPath = feedPath ??
      `/api/v1/integrations/searches/${encodeURIComponent(this.searchId)}/webhook/events`;
    this.longPollSeconds = longPollSeconds;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clock = clock;
  }

  buildUrl(cursor = null) {
    const url = new URL(this.feedPath, this.baseUrl);
    url.searchParams.set("wait_seconds", String(this.longPollSeconds));
    if (cursor) url.searchParams.set("cursor", cursor);
    return url;
  }

  async poll({ cursor = null, signal } = {}) {
    const url = this.buildUrl(cursor);
    const timeout = timeoutSignal(this.requestTimeoutMs, signal);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.bearerToken}`,
        },
        signal: timeout?.signal ?? signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || timeout?.signal?.aborted) {
        throw new FeedClientError("Feed request aborted or timed out", { code: "request_aborted" });
      }
      throw new FeedClientError("Feed request failed", { code: "request_failed", body: { message: error.message } });
    } finally {
      timeout?.dispose();
    }
    if (response.status === 204) {
      return { schemaVersion: 2, events: [], invalidEvents: [], nextCursor: cursor, cursorExpiresAt: null, hasMore: false };
    }
    let body = null;
    try { body = await response.json(); } catch {
      throw new FeedClientError("Feed response was not valid JSON", { code: "invalid_json", status: response.status });
    }
    if (response.status === 409 || response.status === 410 || body?.error_code === "cursor_expired" || body?.code === "cursor_expired") {
      throw new FeedCursorExpiredError("The Vinotify feed cursor expired", { status: response.status, body });
    }
    if (!response.ok) {
      throw new FeedClientError(`Feed request returned HTTP ${response.status}`, {
        code: response.status === 401 || response.status === 403 ? "unauthorized" : "http_error",
        status: response.status,
        body,
      });
    }
    try {
      return normalizeFeedPage(body, { receivedAt: this.clock().toISOString() });
    } catch (error) {
      throw new FeedClientError("Feed response failed schema validation", {
        code: "schema_invalid",
        status: response.status,
        body: { message: error.message },
      });
    }
  }
}
