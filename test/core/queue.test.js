import assert from "node:assert/strict";
import test from "node:test";
import { LocalDatabase } from "../../src/storage/database.js";
import { AgentStore } from "../../src/storage/repository.js";
import { PurchaseQueue } from "../../src/core/queue.js";
import { PurchasePolicy } from "../../src/core/policy.js";
import { EXECUTION_MODES, ATTEMPT_STATES, RESERVATION_STATES } from "../../src/core/types.js";
import { PAYMENT_OUTCOMES, RECONCILE_OUTCOMES } from "../../src/core/browser-executor.js";
import { makeClock, makeEvent, makePage } from "../helpers.js";

function setup({ mode = EXECUTION_MODES.DRY_RUN, executorOverrides = {}, policyOverrides = {} } = {}) {
  const clock = makeClock();
  const database = new LocalDatabase(":memory:", { clock: clock.now });
  const store = new AgentStore(database, { clock: clock.now });
  const policy = new PurchasePolicy({
    marketAllowlist: ["GB"], currencyAllowlist: ["GBP"], searchAllowlist: ["search-1"],
    maxEventAgeMs: 120_000, maxItemPriceMinor: 2_000, maxCheckoutTotalMinor: 2_500,
    maxDailySpendMinor: 10_000, maxDailyCount: 5, clock: clock.now, ...policyOverrides,
  });
  const calls = [];
  const executor = {
    async openListing(attempt) { calls.push(["openListing", attempt.itemId]); return { tab: "tab" }; },
    async inspectListing(attempt) { calls.push(["inspectListing", attempt.itemId]); return { available: true, itemId: attempt.itemId, priceMinor: attempt.itemPriceMinor }; },
    async openCheckout() { calls.push(["openCheckout"]); return { checkout: true }; },
    async readCheckout(attempt) { calls.push(["readCheckout"]); return { itemId: attempt.itemId, itemPriceMinor: attempt.itemPriceMinor, totalMinor: attempt.itemPriceMinor + 200, currency: "GBP" }; },
    async submitPayment() { calls.push(["submitPayment"]); return { outcome: PAYMENT_OUTCOMES.SUBMITTED, orderId: "order-1" }; },
    async reconcileOrder() { calls.push(["reconcileOrder"]); return { outcome: RECONCILE_OUTCOMES.SUCCEEDED, orderId: "order-1" }; },
    ...executorOverrides,
  };
  const queue = new PurchaseQueue({ store, policy, executor, clock: clock.now });
  queue.setMode(mode);
  const event = makeEvent();
  store.ingestFeedBatch("feed", makePage([event]));
  return { clock, database, store, policy, executor, queue, calls, event };
}

test("dry-run processes exactly one serial attempt and releases reservation", async () => {
  const { database, store, queue, event, calls } = setup();
  const enqueued = await queue.enqueueEvent(event);
  assert.equal(enqueued.created.length, 1);
  const result = await queue.drain();
  assert.equal(result.processed.length, 1);
  const attempt = store.getAttempt(enqueued.created[0].attemptId);
  assert.equal(attempt.state, ATTEMPT_STATES.DRY_RUN);
  assert.equal(store.getReservation(attempt.attemptId).state, RESERVATION_STATES.RELEASED);
  assert.deepEqual(calls.map(([name]) => name), ["openListing", "inspectListing", "openCheckout", "readCheckout"]);
  assert.equal(store.getNextQueuedAttempt(), null);
  database.close();
});

test("human-final mode persists needs_user_action and reconciles only after explicit result", async () => {
  const { database, store, queue, event, calls } = setup({ mode: EXECUTION_MODES.HUMAN_FINAL });
  queue.arm({ durationMs: 60_000 });
  const { created } = await queue.enqueueEvent(event);
  let result = await queue.drain();
  assert.equal(result.processed[0].result, "needs_user_action");
  let attempt = store.getAttempt(created[0].attemptId);
  assert.equal(attempt.state, ATTEMPT_STATES.NEEDS_USER_ACTION);
  assert.equal(attempt.reason, "human_final_required");
  assert.equal(calls.some(([name]) => name === "submitPayment"), false);
  result = await queue.recordHumanFinal(attempt.attemptId, { outcome: PAYMENT_OUTCOMES.SUBMITTED, orderId: "order-human" });
  assert.equal(result.result, "succeeded");
  attempt = store.getAttempt(attempt.attemptId);
  assert.equal(attempt.state, ATTEMPT_STATES.SUCCEEDED);
  assert.equal(attempt.orderId, "order-1");
  database.close();
});

test("auto-submit is blocked while disarmed and succeeds when armed", async () => {
  const { database, store, queue, event } = setup({ mode: EXECUTION_MODES.AUTO_SUBMIT });
  const { created } = await queue.enqueueEvent(event);
  let result = await queue.drain();
  assert.equal(result.blocked, true);
  assert.equal(store.getAttempt(created[0].attemptId).state, ATTEMPT_STATES.QUEUED);
  queue.arm({ durationMs: 60_000 });
  result = await queue.drain();
  assert.equal(result.processed[0].result, "succeeded");
  assert.equal(store.getAttempt(created[0].attemptId).state, ATTEMPT_STATES.SUCCEEDED);
  database.close();
});

test("auto-submit marks ambiguous payment failures unknown and never retries", async () => {
  const { database, store, queue, event, calls } = setup({
    mode: EXECUTION_MODES.AUTO_SUBMIT,
    executorOverrides: {
      async submitPayment() { calls.push(["submitPayment"]); throw new Error("browser disconnected after click"); },
    },
  });
  queue.arm({ durationMs: 60_000 });
  const { created } = await queue.enqueueEvent(event);
  const result = await queue.drain();
  assert.equal(result.processed[0].result, "unknown");
  assert.equal(store.getAttempt(created[0].attemptId).state, ATTEMPT_STATES.UNKNOWN);
  assert.equal(store.getReservation(created[0].attemptId).state, RESERVATION_STATES.HELD);
  assert.equal(store.getNextQueuedAttempt(), null);
  await assert.rejects(() => queue.recordHumanFinal(created[0].attemptId, { outcome: PAYMENT_OUTCOMES.SUBMITTED }), /not waiting/);
  database.close();
});

test("payment verification pauses without retrying final submit", async () => {
  const { database, store, queue, event, calls } = setup({
    mode: EXECUTION_MODES.AUTO_SUBMIT,
    executorOverrides: {
      async submitPayment() { calls.push(["submitPayment"]); return { outcome: PAYMENT_OUTCOMES.NEEDS_USER_ACTION, reason: "payment_verification_required" }; },
      async reconcileOrder() { calls.push(["reconcileOrder"]); return { outcome: RECONCILE_OUTCOMES.SUCCEEDED, orderId: "order-after-verification" }; },
    },
  });
  queue.arm({ durationMs: 60_000 });
  const { created } = await queue.enqueueEvent(event);
  let result = await queue.drain();
  assert.equal(result.processed[0].result, "needs_user_action");
  assert.equal(store.getAttempt(created[0].attemptId).state, ATTEMPT_STATES.NEEDS_USER_ACTION);
  result = await queue.reconcileAttempt(created[0].attemptId);
  assert.equal(result.result, "succeeded");
  assert.deepEqual(calls.map(([name]) => name), ["openListing", "inspectListing", "openCheckout", "readCheckout", "submitPayment", "reconcileOrder"]);
  database.close();
});

test("duplicate feed events produce one durable attempt", async () => {
  const { database, store, queue, event } = setup();
  await queue.enqueueEvent(event);
  const duplicate = await queue.enqueueEvent(event);
  assert.equal(duplicate.created.length, 0);
  assert.equal(store.listAttempts().length, 1);
  database.close();
});

test("final total changes or exceeds policy cause a failed, released attempt", async () => {
  const { database, store, queue, event } = setup({
    executorOverrides: {
      async readCheckout(attempt) { return { itemId: attempt.itemId, itemPriceMinor: attempt.itemPriceMinor + 1, totalMinor: 3000, currency: "GBP" }; },
    },
  });
  const { created } = await queue.enqueueEvent(event);
  const result = await queue.drain();
  assert.equal(result.processed[0].result, "failed");
  assert.equal(store.getAttempt(created[0].attemptId).state, ATTEMPT_STATES.FAILED);
  assert.equal(store.getReservation(created[0].attemptId).state, RESERVATION_STATES.RELEASED);
  database.close();
});

test("arm expiry and mode persist, and disarm is immediate", () => {
  const { database, queue, clock } = setup({ mode: EXECUTION_MODES.AUTO_SUBMIT });
  queue.arm({ durationMs: 1_000 });
  assert.equal(queue.getArmState().armed, true);
  clock.advance(1_001);
  assert.equal(queue.getArmState().armed, false);
  queue.arm({ durationMs: 60_000 });
  queue.disarm("test");
  assert.equal(queue.getArmState().armed, false);
  assert.equal(queue.getMode(), EXECUTION_MODES.AUTO_SUBMIT);
  database.close();
});

test("restart recovery does not retry an attempt whose final boundary was persisted", async () => {
  const { database, store, queue, event, calls } = setup({ mode: EXECUTION_MODES.AUTO_SUBMIT });
  queue.arm({ durationMs: 60_000 });
  const { created } = await queue.enqueueEvent(event);
  const attempt = store.getAttempt(created[0].attemptId);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.LISTING_CHECKED);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.CHECKOUT_OPENED);
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.TOTAL_VERIFIED, { finalTotalMinor: 1434 });
  store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.PAYMENT_SUBMITTED);
  const recovery = queue.recoverAfterCrash();
  assert.deepEqual(recovery.ambiguous, [attempt.attemptId]);
  assert.equal(store.getAttempt(attempt.attemptId).state, ATTEMPT_STATES.UNKNOWN);
  assert.equal(store.getNextQueuedAttempt(), null);
  assert.equal(calls.length, 0);
  database.close();
});

test("queued attempts are freshness-checked again before browser execution", async () => {
  const { database, store, queue, event, clock, calls } = setup({
    policyOverrides: { maxEventAgeMs: 60_000 },
  });
  const { created } = await queue.enqueueEvent(event);

  clock.advance(61_000);
  const result = await queue.drain();

  assert.equal(result.processed[0].result, "failed");
  assert.equal(store.getAttempt(created[0].attemptId).reason, "event_not_fresh");
  assert.equal(calls.length, 0);
  assert.equal(store.getReservation(created[0].attemptId).state, RESERVATION_STATES.RELEASED);
  database.close();
});

test("queued work is skipped when its search is removed from the current discovery scope", async () => {
  const { database, store, queue, event, calls } = setup();
  const { created } = await queue.enqueueEvent(event);
  queue.setSearchMembership({ accountFingerprint: "acct-1", searchIds: [], ready: true });
  const result = await queue.drain();
  assert.equal(result.processed[0].result, "skipped");
  assert.equal(store.getAttempt(created[0].attemptId).state, ATTEMPT_STATES.SKIPPED);
  assert.equal(store.getAttempt(created[0].attemptId).reason, "search_not_currently_discovered");
  assert.equal(calls.length, 0);
  assert.equal(store.getReservation(created[0].attemptId).state, RESERVATION_STATES.RELEASED);
  database.close();
});

test("membership is rechecked after checkout and before a payment call", async () => {
  let releaseCheckout;
  let checkoutRead;
  const { database, store, queue, event, calls } = setup({
    mode: EXECUTION_MODES.AUTO_SUBMIT,
    executorOverrides: {
      async readCheckout(attempt) {
        checkoutRead = true;
        await new Promise((resolve) => { releaseCheckout = resolve; });
        return { itemId: attempt.itemId, itemPriceMinor: attempt.itemPriceMinor, totalMinor: attempt.itemPriceMinor + 200, currency: "GBP" };
      },
    },
  });
  queue.arm({ durationMs: 60_000 });
  const { created } = await queue.enqueueEvent(event);
  const draining = queue.drain();
  while (!checkoutRead) await new Promise((resolve) => setImmediate(resolve));
  queue.setSearchMembership({ accountFingerprint: "acct-1", searchIds: [], ready: true });
  releaseCheckout();
  const result = await draining;
  assert.equal(result.processed[0].result, "failed");
  assert.equal(store.getAttempt(created[0].attemptId).reason, "search_not_currently_discovered");
  assert.equal(calls.includes(["submitPayment"]), false);
  database.close();
});

test("a login challenge pauses before payment and can be explicitly resumed", async () => {
  let challenged = true;
  const { database, store, queue, event } = setup({
    executorOverrides: {
      async openListing() {
        if (challenged) return { needsUserAction: true, reason: "login_required" };
        return { ok: true };
      },
    },
  });
  const { created } = await queue.enqueueEvent(event);
  let result = await queue.drain();
  assert.equal(result.processed[0].result, "needs_user_action");
  assert.equal(store.getAttempt(created[0].attemptId).reason, "pre_submit_login_required");

  challenged = false;
  queue.resumePreSubmit(created[0].attemptId);
  result = await queue.drain();
  assert.equal(result.processed[0].result, "dry_run");
  database.close();
});

test("an ambiguous payment stops the serial queue before another listing", async () => {
  const { database, store, queue, event, calls } = setup({
    mode: EXECUTION_MODES.AUTO_SUBMIT,
    policyOverrides: { maxDailyCount: 5 },
    executorOverrides: {
      async submitPayment() {
        calls.push(["submitPayment"]);
        return { outcome: PAYMENT_OUTCOMES.UNKNOWN, reason: "payment_pending" };
      },
    },
  });
  const second = {
    ...event.items[0],
    itemId: "item-2",
    itemKey: "search-1:GB:item-2",
    url: "https://vinted.example/items/2",
  };
  const secondEvent = { ...event, eventId: "evt-2", items: [second] };
  store.ingestFeedBatch("second", makePage([secondEvent], "cursor-2"));
  await queue.enqueueEvent(event);
  await queue.enqueueEvent(secondEvent);
  queue.arm({ durationMs: 60_000 });

  const result = await queue.drain();
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "unknown");
  assert.equal(store.listAttempts({ states: [ATTEMPT_STATES.QUEUED] }).length, 1);
  assert.equal(calls.filter(([name]) => name === "openListing").length, 1);
  database.close();
});

test("unknown payment can be resolved only through read-only reconciliation", async () => {
  const { database, store, queue, event } = setup({
    mode: EXECUTION_MODES.AUTO_SUBMIT,
    executorOverrides: {
      async submitPayment() { return { outcome: PAYMENT_OUTCOMES.UNKNOWN, reason: "payment_pending" }; },
      async reconcileOrder() { return { outcome: RECONCILE_OUTCOMES.SUCCEEDED, orderId: "resolved-order" }; },
    },
  });
  queue.arm({ durationMs: 60_000 });
  const { created } = await queue.enqueueEvent(event);
  await queue.drain();
  assert.equal(store.getAttempt(created[0].attemptId).state, ATTEMPT_STATES.UNKNOWN);

  const result = await queue.reconcileAttempt(created[0].attemptId);
  assert.equal(result.result, "succeeded");
  assert.equal(store.getAttempt(created[0].attemptId).orderId, "resolved-order");
  assert.equal(store.getReservation(created[0].attemptId).state, RESERVATION_STATES.COMMITTED);
  database.close();
});
