import assert from "node:assert/strict";
import test from "node:test";
import { PolicyRejection, PurchasePolicy } from "../../src/core/policy.js";
import { makeClock, makeEvent, NOW } from "../helpers.js";

function policy(clock) {
  return new PurchasePolicy({
    marketAllowlist: ["GB"],
    currencyAllowlist: ["GBP"],
    searchAllowlist: ["search-1"],
    maxEventAgeMs: 120_000,
    maxItemPriceMinor: 2_000,
    maxCheckoutTotalMinor: 2_500,
    maxDailySpendMinor: 5_000,
    maxDailyCount: 2,
    clock: clock.now,
  });
}

test("policy enforces market, currency, search and freshness allowlists", () => {
  const clock = makeClock();
  const p = policy(clock);
  assert.equal(p.evaluateEvent(makeEvent()).ok, true);
  for (const [field, value, reason] of [
    ["market", "FR", "market_not_allowed"],
    ["currency", "EUR", "currency_not_allowed"],
    ["searchId", "other", "search_not_allowed"],
  ]) {
    const event = makeEvent({ [field]: value });
    assert.throws(() => p.evaluateEvent(event), (error) => error instanceof PolicyRejection && error.reason === reason);
  }
  clock.advance(121_000);
  assert.throws(() => p.evaluateEvent(makeEvent()), (error) => error.reason === "event_not_fresh");
});

test("policy enforces item and final checkout limits", () => {
  const clock = makeClock();
  const p = policy(clock);
  const event = makeEvent({ price: "20.01" });
  assert.throws(() => p.evaluateItem(event, event.items[0]), (error) => error.reason === "item_price_exceeds_limit");
  const allowed = makeEvent({ price: "20.00" });
  const attempt = {
    itemId: "item-1",
    itemPriceMinor: 2000,
    currency: "GBP",
  };
  assert.equal(p.evaluateFinalTotal(attempt, { itemId: "item-1", itemPriceMinor: 2000, totalMinor: 2200, currency: "GBP" }).totalMinor, 2200);
  assert.throws(() => p.evaluateFinalTotal(attempt, { itemId: "item-1", itemPriceMinor: 2000, totalMinor: 2501, currency: "GBP" }), (error) => error.reason === "checkout_total_exceeds_limit");
  assert.throws(() => p.evaluateFinalTotal(attempt, { itemId: "other", itemPriceMinor: 2000, totalMinor: 2200, currency: "GBP" }), (error) => error.reason === "checkout_item_mismatch");
  assert.equal(allowed.items[0].priceMinor, 2000);
});

test("daily usage is checked before a new reservation", () => {
  const clock = makeClock(NOW);
  const p = policy(clock);
  assert.doesNotThrow(() => p.checkDailyUsage({ spendMinor: 4_999, count: 1 }));
  assert.throws(() => p.checkDailyUsage({ spendMinor: 5_001, count: 0 }), (error) => error.reason === "daily_spend_exceeds_limit");
  assert.throws(() => p.checkDailyUsage({ spendMinor: 0, count: 2 }), (error) => error.reason === "daily_count_exceeds_limit");
});
