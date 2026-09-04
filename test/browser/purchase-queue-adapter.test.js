import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PAYMENT_OUTCOMES,
  RECONCILE_OUTCOMES,
} from "../../src/core/browser-executor.js";
import {
  PurchaseQueueBrowserAdapter,
} from "../../src/browser/purchase-queue-adapter.js";

const listingUrl = "https://www.vinted.co.uk/items/12345-coat";
const attempt = {
  attemptId: "7b2d15bb-2cb3-4f4e-b3aa-7af7862e1b62",
  itemKey: "search-1:UK:12345",
  itemId: "12345",
  itemPriceMinor: 1234,
  currency: "GBP",
};

function executorFixture(overrides = {}) {
  const calls = [];
  const base = {
    async openListing(input) { calls.push(["openListing", input]); return { ok: true, status: "listing_opened" }; },
    async inspectListing(input) {
      calls.push(["inspectListing", input]);
      return { ok: true, status: "listing_verified", listing: { itemId: "12345", available: true, price: { amountMinor: 1234, currency: "GBP" } } };
    },
    async openCheckout(input) { calls.push(["openCheckout", input]); return { ok: true, status: "checkout_opened", itemId: "12345" }; },
    async inspectCheckout(input) {
      calls.push(["inspectCheckout", input]);
      return { ok: true, status: "checkout_verified", checkout: { itemId: "12345", total: { amountMinor: 1540, currency: "GBP" }, paymentMethodLabel: "Saved card" } };
    },
    async readCheckout(input) { calls.push(["readCheckout", input]); return this.inspectCheckout(input); },
    async submitPayment(input) { calls.push(["submitPayment", input]); return { ok: true, status: "success", outcome: "submitted", itemId: "12345" }; },
    async reconcileOrder(input) { calls.push(["reconcileOrder", input]); return { ok: true, status: "success", outcome: "succeeded", itemId: "12345" }; },
    async requestUserAction(input) { calls.push(["requestUserAction", input]); return { ok: true }; },
    async close() { calls.push(["close"]); return { ok: true }; },
  };
  return { executor: { ...base, ...overrides }, calls };
}

function makeAdapter(executor, { item = {} } = {}) {
  let lookups = 0;
  const adapter = new PurchaseQueueBrowserAdapter({
    executor,
    itemLookup: async ({ itemKey, itemId }) => {
      lookups += 1;
      assert.equal(itemKey, attempt.itemKey);
      assert.equal(itemId, attempt.itemId);
      return { itemId: "12345", url: listingUrl, priceMinor: 1234, currency: "GBP", ...item };
    },
  });
  return { adapter, get lookups() { return lookups; } };
}

test("adapter supplies stored listing data and maps the complete core contract", async () => {
  const { executor, calls } = executorFixture();
  const made = makeAdapter(executor);
  const { adapter } = made;
  assert.deepEqual(await adapter.openListing(attempt), {
    ok: true,
    itemId: "12345",
    priceMinor: 1234,
    currency: "GBP",
    url: listingUrl,
    browserStatus: "listing_opened",
  });
  assert.deepEqual(await adapter.inspectListing(attempt), {
    ok: true,
    available: true,
    itemId: "12345",
    priceMinor: 1234,
    currency: "GBP",
    browserStatus: "listing_verified",
  });
  assert.deepEqual(await adapter.openCheckout(attempt), {
    ok: true,
    itemId: "12345",
    browserStatus: "checkout_opened",
  });
  assert.deepEqual(await adapter.readCheckout(attempt), {
    ok: true,
    itemId: "12345",
    itemPriceMinor: 1234,
    totalMinor: 1540,
    currency: "GBP",
    paymentMethodLabel: "Saved card",
    browserStatus: "checkout_verified",
  });
  assert.deepEqual(await adapter.submitPayment(attempt), {
    outcome: PAYMENT_OUTCOMES.SUBMITTED,
    orderId: null,
  });
  assert.deepEqual(await adapter.reconcileOrder(attempt), {
    outcome: RECONCILE_OUTCOMES.SUCCEEDED,
    orderId: null,
    reason: "order_confirmed",
  });
  assert.equal(made.lookups, 1, "stored item is read once per attempt");
  assert.deepEqual(calls[0], ["openListing", {
    url: listingUrl,
    itemId: "12345",
    expectedPriceMinor: 1234,
    expectedCurrency: "GBP",
  }]);
});

test("adapter forwards a durable attempt order ID during reconciliation", async () => {
  const { executor, calls } = executorFixture();
  const { adapter } = makeAdapter(executor);
  await adapter.reconcileOrder({ ...attempt, orderId: "987" });
  assert.deepEqual(calls.at(-1), ["reconcileOrder", { itemId: "12345", orderId: "987" }]);
});

test("non-OK listing and malformed stored data fail before any later phase", async () => {
  const { executor, calls } = executorFixture({
    async openListing() { return { ok: false, status: "unknown", reason: "listing_price_unverified" }; },
  });
  const { adapter } = makeAdapter(executor);
  await assert.rejects(
    () => adapter.openListing(attempt),
    (error) => error.code === "BROWSER_ADAPTER_OPEN_LISTING_FAILED",
  );
  assert.equal(calls.length, 0, "the fake override did not record a click or later phase");

  const malformed = makeAdapter(executor, { item: { url: "https://example.invalid/items/12345" } });
  await assert.rejects(() => malformed.adapter.openListing(attempt), /stored_item_fields_invalid/);
});

test("challenge states at every pre-payment phase request user action and never fail closed as payable", async () => {
  for (const phase of ["openListing", "inspectListing", "openCheckout", "inspectCheckout"]) {
    const fixture = executorFixture();
    fixture.executor[phase] = async () => ({
      ok: false,
      status: "login_required",
      reason: "login_required",
    });
    const { adapter } = makeAdapter(fixture.executor);
    const result = await adapter[phase](attempt);
    assert.deepEqual(result, {
      needsUserAction: true,
      reason: "login_required",
      status: "login_required",
    });
    assert.deepEqual(fixture.calls.at(-1), ["requestUserAction", { reason: "login_required" }]);
  }
});

test("challenge and ambiguous payment results map to user-action/unknown without retry", async () => {
  const fixture = executorFixture();
  const { executor, calls } = fixture;
  executor.submitPayment = async (input) => {
    calls.push(["submitPayment", input]);
    return { ok: false, status: "verification_required", reason: "verification_required" };
  };
  executor.reconcileOrder = async (input) => {
    calls.push(["reconcileOrder", input]);
    return { ok: false, status: "payment_pending", reason: "payment_pending" };
  };
  const { adapter } = makeAdapter(executor);
  assert.deepEqual(await adapter.submitPayment(attempt), {
    outcome: PAYMENT_OUTCOMES.NEEDS_USER_ACTION,
    reason: "verification_required",
  });
  assert.deepEqual(calls.at(-1), ["requestUserAction", { reason: "verification_required" }]);
  assert.deepEqual(await adapter.reconcileOrder(attempt), {
    outcome: RECONCILE_OUTCOMES.UNKNOWN,
    reason: "payment_pending",
  });
  assert.equal(calls.filter(([name]) => name === "submitPayment").length, 1);
});

test("a possibly crossed payment boundary maps to one core reconciliation", async () => {
  const fixture = executorFixture();
  const { executor } = fixture;
  executor.submitPayment = async () => ({
    ok: false,
    status: "payment_pending",
    reason: "payment_submission_uncertain_reconcile_required",
  });
  const { adapter } = makeAdapter(executor);
  assert.deepEqual(await adapter.submitPayment(attempt), {
    outcome: PAYMENT_OUTCOMES.SUBMITTED,
    orderId: null,
  });
});

test("checkout mismatch is not converted into a payable core shape", async () => {
  const { executor } = executorFixture({
    async inspectCheckout() {
      return { ok: true, status: "checkout_verified", checkout: { itemId: "12345", total: { amountMinor: 1540, currency: "EUR" }, paymentMethodLabel: "Saved card" } };
    },
  });
  const { adapter } = makeAdapter(executor);
  await assert.rejects(
    () => adapter.inspectCheckout(attempt),
    (error) => error.code === "BROWSER_ADAPTER_INSPECT_CHECKOUT_FAILED",
  );
});
