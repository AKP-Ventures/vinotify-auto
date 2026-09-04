import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { createControlUi } from "../../src/ui/control-ui.js";
import { EXECUTION_MODES } from "../../src/core/types.js";

function request(ui, { method = "GET", path = "/", headers = {}, body } = {}) {
  const url = new URL(path, ui.origin);
  return new Promise((resolvePromise, rejectPromise) => {
    const requestObject = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolvePromise({
            statusCode: response.statusCode,
            headers: response.headers,
            body: raw,
            json: () => JSON.parse(raw),
          });
        });
      },
    );
    requestObject.on("error", rejectPromise);
    if (body !== undefined) requestObject.end(body);
    else requestObject.end();
  });
}

test("control UI is loopback-only, same-origin, and delegates to injected service", async () => {
  const calls = [];
  const service = {
    async status() { return { state: "idle", armed: false }; },
    async settings() {
      return {
        market: "UK",
        maxTotalMinor: 2500,
        purchase: {
          currencyAllowlist: ["GBP"],
          maxItemPriceMinor: 2500,
          maxCheckoutTotalMinor: 4000,
          maxDailySpendMinor: 10000,
          maxDailyCount: 2,
          armDurationSeconds: 900,
        },
      };
    },
    async mode() { return { mode: EXECUTION_MODES.DRY_RUN }; },
    async setMode(value) { calls.push(["setMode", value]); return value; },
    async updatePurchaseLimits(value) { calls.push(["updatePurchaseLimits", value]); return { purchase: value }; },
    async arm(value) { calls.push(["arm", value]); return { armed: true }; },
    async disarm() { calls.push(["disarm"]); return { armed: false }; },
    async resumeAttempt(value) { calls.push(["resumeAttempt", value]); return { resumed: true }; },
    async recordHumanSubmitted(value) { calls.push(["recordHumanSubmitted", value]); return { recorded: true }; },
    async reconcileAttempt(value) { calls.push(["reconcileAttempt", value]); return { reconciled: true }; },
    async resetFeedCursor(value) { calls.push(["resetFeedCursor", value]); return { reset: true }; },
    async recentAttempts(value) { calls.push(["recentAttempts", value]); return [{ status: "skipped" }]; },
    async health() { return { ok: true }; },
  };
  const ui = createControlUi({ service });
  await ui.start();
  try {
    assert.match(ui.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await request(ui, { path: "/", headers: { Origin: ui.origin } });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
    assert.match(page.headers["content-security-policy"], /script-src 'nonce-/);
    assert.match(page.body, /meta name="csrf-token"/);
    assert.match(page.body, /value="dry_run"/);
    assert.match(page.body, /value="human_final"/);
    assert.match(page.body, /value="auto_submit"/);
    assert.match(page.body, /window\.confirm/);
    assert.match(page.body, /data-action="retry"/);
    assert.match(page.body, /id="summary-title"/);
    assert.match(page.body, />Buying safety</);
    assert.match(page.body, /id="limits-summary"/);
    assert.match(page.body, /data-action="edit-limits"[^>]*>Edit limits/);
    assert.match(page.body, /<form id="limits-form"[^>]*hidden/);
    assert.match(page.body, /Max item price/);
    assert.match(page.body, /Max checkout/);
    assert.match(page.body, /Max daily spend/);
    assert.match(page.body, /data-limit-currency/);
    assert.match(page.body, /Purchases\/day/);
    assert.match(page.body, /Armed duration \(minutes\)/);
    assert.match(page.body, /Saving limits disarms the agent/);
    assert.match(page.body, /id="feeds"/);
    assert.match(page.body, /<summary>Technical details<\/summary>/);
    assert.match(page.body, /Runs on this device\. Starts safely disarmed\./);
    assert.doesNotMatch(page.body, /<dl id="(?:status|settings|health)"/);
    assert.doesNotMatch(page.body, /dd\.textContent\s*=\s*typeof item === 'object'/);
    const inlineScript = page.body.match(/<script nonce="[A-Za-z0-9_-]+">([\s\S]*)<\/script>/)?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Function(inlineScript));
    assert.match(inlineScript, /AbortSignal\.timeout/);
    assert.match(inlineScript, /AbortController/);
    assert.match(inlineScript, /maxItemPriceMinor/);
    assert.match(inlineScript, /Limits saved\. Agent disarmed\./);
    assert.ok(inlineScript.includes("if (!/^\\d+(?:\\.\\d{1,2})?$/.test(raw))"));
    assert.ok(inlineScript.includes("maxDailyCount: /^\\d+$/.test"));
    assert.doesNotMatch(page.body, /https?:\/\/(?!127\.0\.0\.1)/);

    const status = await request(ui, { path: "/api/status", headers: { Origin: ui.origin } });
    assert.deepEqual(status.json(), { state: "idle", armed: false });
    const attempts = await request(ui, { path: "/api/attempts?limit=200" });
    assert.deepEqual(attempts.json(), [{ status: "skipped" }]);
    assert.deepEqual(calls.at(-1), ["recentAttempts", { limit: 100 }]);

    const missingOrigin = await request(ui, {
      method: "POST",
      path: "/api/arm",
      headers: { "X-CSRF-Token": ui.csrfToken },
      body: "{}",
    });
    assert.equal(missingOrigin.statusCode, 403);
    assert.equal(missingOrigin.json().error, "origin_required");

    const missingCsrf = await request(ui, {
      method: "POST",
      path: "/api/mode",
      headers: { Origin: ui.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: EXECUTION_MODES.AUTO_SUBMIT }),
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(missingCsrf.json().error, "csrf_failed");

    const mode = await request(ui, {
      method: "POST",
      path: "/api/mode",
      headers: {
        Origin: ui.origin,
        "X-CSRF-Token": ui.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: EXECUTION_MODES.HUMAN_FINAL }),
    });
    assert.equal(mode.statusCode, 200);
    assert.deepEqual(calls.at(-1), ["setMode", { mode: EXECUTION_MODES.HUMAN_FINAL }]);

    const purchase = {
      maxItemPriceMinor: 3000,
      maxCheckoutTotalMinor: 4500,
      maxDailySpendMinor: 12000,
      maxDailyCount: 3,
      armDurationSeconds: 1200,
    };
    const savedLimits = await request(ui, {
      method: "POST",
      path: "/api/settings",
      headers: {
        Origin: ui.origin,
        "X-CSRF-Token": ui.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ purchase }),
    });
    assert.equal(savedLimits.statusCode, 200);
    assert.deepEqual(savedLimits.json(), { purchase });
    assert.deepEqual(calls.at(-1), ["updatePurchaseLimits", purchase]);

    const legacyMode = await request(ui, {
      method: "POST",
      path: "/api/mode",
      headers: {
        Origin: ui.origin,
        "X-CSRF-Token": ui.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "human-final" }),
    });
    assert.equal(legacyMode.statusCode, 422);
    assert.equal(legacyMode.json().error, "invalid_mode");

    const attemptId = "7b2d15bb-2cb3-4f4e-b3aa-7af7862e1b62";
    const actionHeaders = {
      Origin: ui.origin,
      "X-CSRF-Token": ui.csrfToken,
      "Content-Type": "application/json",
    };
    const resume = await request(ui, {
      method: "POST",
      path: `/api/attempts/${attemptId}/resume`,
      headers: actionHeaders,
    });
    assert.equal(resume.statusCode, 200);
    assert.deepEqual(calls.at(-1), ["resumeAttempt", { attemptId }]);

    const unconfirmed = await request(ui, {
      method: "POST",
      path: `/api/attempts/${attemptId}/human-submitted`,
      headers: actionHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmed.statusCode, 422);
    assert.equal(unconfirmed.json().error, "human_submission_confirmation_required");

    const humanSubmitted = await request(ui, {
      method: "POST",
      path: `/api/attempts/${attemptId}/human-submitted`,
      headers: actionHeaders,
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(humanSubmitted.statusCode, 200);
    assert.deepEqual(calls.at(-1), ["recordHumanSubmitted", { attemptId }]);

    const reconcile = await request(ui, {
      method: "POST",
      path: `/api/attempts/${attemptId}/reconcile`,
      headers: actionHeaders,
    });
    assert.equal(reconcile.statusCode, 200);
    assert.deepEqual(calls.at(-1), ["reconcileAttempt", { attemptId }]);

    const invalidAttempt = await request(ui, {
      method: "POST",
      path: "/api/attempts/not-an-id/resume",
      headers: actionHeaders,
    });
    assert.equal(invalidAttempt.statusCode, 422);
    assert.equal(invalidAttempt.json().error, "invalid_attempt_id");

    const unconfirmedReset = await request(ui, {
      method: "POST",
      path: "/api/feeds/42/reset-cursor",
      headers: actionHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmedReset.statusCode, 422);
    assert.equal(unconfirmedReset.json().error, "feed_gap_confirmation_required");

    const reset = await request(ui, {
      method: "POST",
      path: "/api/feeds/42/reset-cursor",
      headers: actionHeaders,
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(calls.at(-1), ["resetFeedCursor", { searchId: 42 }]);

    const arm = await request(ui, {
      method: "POST",
      path: "/api/arm",
      headers: {
        Origin: ui.origin,
        "X-CSRF-Token": ui.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttlSeconds: 60 }),
    });
    assert.equal(arm.statusCode, 200);
    assert.deepEqual(calls.at(-1), ["arm", { ttlSeconds: 60 }]);

    const crossOrigin = await request(ui, {
      path: "/api/health",
      headers: { Origin: "http://127.0.0.1:9" },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(crossOrigin.json().error, "origin_not_allowed");
  } finally {
    await ui.stop();
  }
});

test("purchase limits route rejects malformed and unknown fields before service", async () => {
  const calls = [];
  const service = {
    async updatePurchaseLimits(value) { calls.push(value); return value; },
  };
  const ui = createControlUi({ service });
  await ui.start();
  try {
    const valid = {
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
      armDurationSeconds: 900,
    };
    const invalidBodies = [
      {},
      { purchase: { ...valid, extra: 1 } },
      { purchase: { ...valid, maxDailyCount: undefined } },
      { purchase: { ...valid, maxItemPriceMinor: "2500" } },
      { purchase: { ...valid, maxDailyCount: 101 } },
      { purchase: { ...valid, armDurationSeconds: 3601 } },
      { purchase: { ...valid, maxCheckoutTotalMinor: 2499 } },
      { purchase: { ...valid, maxDailySpendMinor: 3999 } },
      { purchase: valid, extra: true },
      { purchase: [] },
    ];
    for (const value of invalidBodies) {
      const response = await request(ui, {
        method: "POST",
        path: "/api/settings",
        headers: {
          Origin: ui.origin,
          "X-CSRF-Token": ui.csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
      });
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json(), { error: "invalid_purchase_limits" });
    }
    assert.deepEqual(calls, []);
  } finally {
    await ui.stop();
  }
});

test("control UI rejects non-loopback binding", () => {
  assert.throws(
    () => createControlUi({ host: "0.0.0.0", service: {} }),
    /127\.0\.0\.1/,
  );
});
