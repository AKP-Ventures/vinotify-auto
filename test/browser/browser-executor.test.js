import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowserExecutor } from "../../src/browser/browser-executor.js";
import {
  classifyText,
  isAllowedListingUrl,
  isAllowedVintedUrl,
  normalizePaymentMethodLabel,
  parseMoney,
} from "../../src/browser/selectors.js";

class EmptyLocator {
  first() {
    return this;
  }
  async count() {
    return 0;
  }
}

class FakeLocator {
  constructor({ text = "", attributes = {}, visible = true, enabled = true, onClick } = {}) {
    this.text = text;
    this.attributes = attributes;
    this.visible = visible;
    this.enabled = enabled;
    this.onClick = onClick;
    this.clicks = 0;
  }
  first() {
    return this;
  }
  async count() {
    return 1;
  }
  async textContent() {
    return this.text;
  }
  async getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  async isVisible() {
    return this.visible;
  }
  async isEnabled() {
    return this.enabled;
  }
  async click() {
    this.clicks += 1;
    if (this.onClick) await this.onClick();
  }
}

class MultiLocator {
  constructor(locators) {
    this.locators = locators;
  }
  first() {
    return this.locators[0];
  }
  async count() {
    return this.locators.length;
  }
  nth(index) {
    return this.locators[index];
  }
}

class FakePage {
  constructor(url, selectors = {}) {
    this.currentUrl = url;
    this.selectors = new Map(Object.entries(selectors));
  }
  url() {
    return this.currentUrl;
  }
  locator(selector) {
    return this.selectors.get(selector) ?? new EmptyLocator();
  }
  async goto(url) {
    this.currentUrl = url;
  }
  async waitForLoadState() {}
}

class FakeController {
  constructor(page) {
    this.currentPage = page;
    this.broughtToFront = 0;
    this.closed = 0;
  }
  async navigate(url) {
    await this.currentPage.goto(url);
    return this.currentPage;
  }
  async page() {
    return this.currentPage;
  }
  async bringToFront() {
    this.broughtToFront += 1;
  }
  async close() {
    this.closed += 1;
  }
}

const listingUrl = "https://www.vinted.co.uk/items/12345-wool-coat";
const checkoutUrl = "https://www.vinted.co.uk/checkout";

function listingPage() {
  const page = new FakePage(listingUrl);
  const buy = new FakeLocator({
    onClick: async () => {
      page.currentUrl = checkoutUrl;
      page.selectors = new Map([
        ['[data-testid="checkout-total"]', new FakeLocator({ text: "£15.40" })],
        ['[data-testid="selected-payment-method"]', new FakeLocator({ text: "Visa saved card •••• 1234" })],
        ['[data-testid="submit-payment"]', new FakeLocator({ onClick: async () => {
          page.currentUrl = "https://www.vinted.co.uk/orders/987";
          page.selectors = new Map([
            ['[data-testid="order-success"]', new FakeLocator({ text: "Order confirmed" })],
            ['[data-testid="order-item-id"]', new FakeLocator({ text: "12345" })],
            ['[data-testid="order-id"]', new FakeLocator({ text: "987" })],
          ]);
        } })],
      ]);
    },
  });
  page.selectors = new Map([
    ['[data-testid="item-id"]', new FakeLocator({ text: "12345" })],
    ['[data-testid="item-availability"]', new FakeLocator({ attributes: { "data-available": "true" } })],
    ['[data-testid="item-price"]', new FakeLocator({ text: "£12.34" })],
    ['[data-testid="buy-button"]', buy],
  ]);
  return { page, buy };
}

test("browser executor verifies listing, checkout, and one payment click", async () => {
  const { page, buy } = listingPage();
  const controller = new FakeController(page);
  const executor = new BrowserExecutor({ controller });

  assert.deepEqual(
    await executor.openListing({
      url: listingUrl,
      itemId: "12345",
      expectedPriceMinor: 1234,
      expectedCurrency: "GBP",
    }),
    { ok: true, status: "listing_opened", itemId: "12345" },
  );
  assert.deepEqual(
    await executor.inspectListing({ itemId: "12345" }),
    {
      ok: true,
      status: "listing_verified",
      listing: { itemId: "12345", available: true, price: { amountMinor: 1234, currency: "GBP" } },
    },
  );
  assert.deepEqual(await executor.openCheckout({ itemId: "12345" }), {
    ok: true,
    status: "checkout_opened",
    itemId: "12345",
  });
  const checkout = await executor.inspectCheckout({
    itemId: "12345",
    expectedTotalMinor: 1540,
    expectedCurrency: "GBP",
  });
  assert.deepEqual(checkout, {
    ok: true,
    status: "checkout_verified",
    checkout: {
      itemId: "12345",
      total: { amountMinor: 1540, currency: "GBP" },
      paymentMethodLabel: "Saved card",
    },
  });
  assert.deepEqual(await executor.submitPayment({ itemId: "12345" }), {
    ok: true,
    status: "success",
    outcome: "submitted",
    itemId: "12345",
  });
  assert.equal(buy.clicks, 1);

  const second = await executor.submitPayment({ itemId: "12345" });
  assert.equal(second.status, "payment_pending");
  assert.equal(second.reason, "payment_attempt_already_made_reconcile_first");
  assert.equal(buy.clicks, 1, "a second call must never click payment again");
  assert.deepEqual(await executor.reconcileOrder({ itemId: "12345" }), {
    ok: true,
    status: "success",
    outcome: "succeeded",
    itemId: "12345",
    orderId: "987",
  });
});

test("listing price changes and unavailable listings fail closed", async () => {
  const { page } = listingPage();
  const controller = new FakeController(page);
  const executor = new BrowserExecutor({ controller });
  await executor.openListing({
    url: listingUrl,
    itemId: "12345",
    expectedPriceMinor: 1234,
    expectedCurrency: "GBP",
  });
  page.selectors.get('[data-testid="item-price"]').text = "£13.34";
  const changed = await executor.inspectListing({ itemId: "12345" });
  assert.equal(changed.status, "price_changed");
  assert.deepEqual(changed.livePrice, { amountMinor: 1334, currency: "GBP" });

  const unavailable = listingPage();
  unavailable.page.selectors.get('[data-testid="item-availability"]').attributes["data-available"] = "false";
  const blockedExecutor = new BrowserExecutor({ controller: new FakeController(unavailable.page) });
  await blockedExecutor.openListing({ url: listingUrl, itemId: "12345", expectedPriceMinor: 1234, expectedCurrency: "GBP" });
  assert.equal((await blockedExecutor.inspectListing({ itemId: "12345" })).status, "sold");
});

test("login, CAPTCHA, verification, pending, success, and unknown states are explicit", async () => {
  assert.equal(classifyText("Please sign in to continue", listingUrl), "login_required");
  assert.equal(classifyText("Complete the CAPTCHA", listingUrl), "captcha");
  assert.equal(classifyText("Payment verification required", checkoutUrl), "verification_required");
  assert.equal(classifyText("Payment pending", checkoutUrl), "payment_pending");
  assert.equal(classifyText("Order confirmed", "https://www.vinted.co.uk/orders/1"), "success");
  assert.equal(classifyText("A changed page", checkoutUrl), "unknown");

  assert.equal(normalizePaymentMethodLabel("Visa saved card •••• 1234"), "Saved card");
  assert.equal(normalizePaymentMethodLabel("Vinted Balance"), "Vinted Balance");
  assert.equal(normalizePaymentMethodLabel("PayPal"), null);
  assert.doesNotMatch(JSON.stringify({ label: normalizePaymentMethodLabel("Visa •••• 1234") }), /1234/);
});

test("exact UK origin and unambiguous money parsing are enforced", () => {
  assert.equal(isAllowedVintedUrl("https://www.vinted.co.uk/items/1-coat"), true);
  assert.equal(isAllowedVintedUrl("https://vinted.co.uk/items/1-coat"), false);
  assert.equal(isAllowedVintedUrl("https://www.vinted.co.uk.evil.example/items/1"), false);
  assert.equal(isAllowedVintedUrl("http://www.vinted.co.uk/items/1"), false);
  assert.equal(isAllowedListingUrl("https://www.vinted.co.uk/items/1-coat", "1"), true);
  assert.equal(isAllowedListingUrl("https://www.vinted.co.uk/items/2-coat", "1"), false);
  assert.deepEqual(parseMoney({ text: "£1,234.56" }), { amountMinor: 123456, currency: "GBP" });
  assert.equal(parseMoney({ text: "12.34" }), null);
});

test("challenge state never invokes payment and requests visible user action", async () => {
  const page = new FakePage(checkoutUrl, {
    '[data-testid="payment-verification"]': new FakeLocator({ text: "Verify" }),
    '[data-testid="submit-payment"]': new FakeLocator(),
  });
  const controller = new FakeController(page);
  const executor = new BrowserExecutor({ controller });
  const action = await executor.requestUserAction({ reason: "verification_required" });
  assert.equal(action.status, "user_action_required");
  assert.equal(controller.broughtToFront, 1);
  assert.equal((await executor.requestUserAction({ reason: "bypass_captcha" })).status, "unknown");
});

test("a new attempt is allowed only after reconciliation positively confirms success", async () => {
  const first = listingPage();
  const controller = new FakeController(first.page);
  const executor = new BrowserExecutor({ controller });
  await executor.openListing({ url: listingUrl, itemId: "12345", expectedPriceMinor: 1234, expectedCurrency: "GBP" });
  await executor.inspectListing({ itemId: "12345" });
  await executor.openCheckout({ itemId: "12345" });
  await executor.inspectCheckout({ itemId: "12345", expectedTotalMinor: 1540, expectedCurrency: "GBP" });
  await executor.submitPayment({ itemId: "12345" });
  assert.equal((await executor.openListing({ url: listingUrl, itemId: "12345", expectedPriceMinor: 1234, expectedCurrency: "GBP" })).reason, "payment_attempt_already_made");
  await executor.reconcileOrder({ itemId: "12345" });

  const secondPage = new FakePage("https://www.vinted.co.uk/items/67890-jacket", {
    '[data-testid="item-id"]': new FakeLocator({ text: "67890" }),
    '[data-testid="item-availability"]': new FakeLocator({ attributes: { "data-available": "true" } }),
    '[data-testid="item-price"]': new FakeLocator({ text: "£8.00" }),
    '[data-testid="buy-button"]': new FakeLocator(),
  });
  controller.currentPage = secondPage;
  assert.deepEqual(await executor.openListing({ url: "https://www.vinted.co.uk/items/67890-jacket", itemId: "67890", expectedPriceMinor: 800, expectedCurrency: "GBP" }), {
    ok: true,
    status: "listing_opened",
    itemId: "67890",
  });
});

test("reconciliation is read-only and works after a fresh executor restart", async () => {
  const page = new FakePage("https://www.vinted.co.uk/orders/987", {
    '[data-testid="order-success"]': new FakeLocator({ text: "Order confirmed" }),
    '[data-testid="order-item-id"]': new FakeLocator({ text: "12345" }),
    '[data-testid="order-id"]': new FakeLocator({ text: "987" }),
  });
  const controller = new FakeController(page);
  const restartedExecutor = new BrowserExecutor({ controller });
  assert.deepEqual(await restartedExecutor.reconcileOrder({ itemId: "12345" }), {
    ok: true,
    status: "success",
    outcome: "succeeded",
    itemId: "12345",
    orderId: "987",
  });
});

test("reconciliation rejects generic, old, and mismatched success evidence", async () => {
  const generic = new FakePage("https://www.vinted.co.uk/orders/old", {
    '[data-testid="order-success"]': new FakeLocator({ text: "Order confirmed" }),
  });
  const genericResult = await new BrowserExecutor({
    controller: new FakeController(generic),
  }).reconcileOrder({ itemId: "12345" });
  assert.equal(genericResult.status, "unknown");
  assert.equal(genericResult.reason, "order_item_id_unverified");

  const oldOrder = new FakePage("https://www.vinted.co.uk/orders/old", {
    '[data-testid="order-success"]': new FakeLocator({ text: "Order confirmed" }),
    '[data-testid="order-item-id"]': new FakeLocator({ text: "67890" }),
    '[data-testid="order-id"]': new FakeLocator({ text: "111" }),
  });
  const oldResult = await new BrowserExecutor({
    controller: new FakeController(oldOrder),
  }).reconcileOrder({ itemId: "12345", orderId: "111" });
  assert.equal(oldResult.status, "unknown");
  assert.equal(oldResult.reason, "order_item_id_mismatch");

  const ambiguousItem = new FakePage("https://www.vinted.co.uk/orders/old", {
    '[data-testid="order-success"]': new FakeLocator({ text: "Order confirmed" }),
    '[data-testid="order-item-id"]': new MultiLocator([
      new FakeLocator({ text: "12345" }),
      new FakeLocator({ text: "67890" }),
    ]),
  });
  const ambiguousResult = await new BrowserExecutor({
    controller: new FakeController(ambiguousItem),
  }).reconcileOrder({ itemId: "12345" });
  assert.equal(ambiguousResult.status, "unknown");
  assert.equal(ambiguousResult.reason, "order_item_id_unverified");

  const mismatchedOrder = new FakePage("https://www.vinted.co.uk/orders/987", {
    '[data-testid="order-success"]': new FakeLocator({ text: "Order confirmed" }),
    '[data-testid="order-item-id"]': new FakeLocator({ text: "12345" }),
    '[data-testid="order-id"]': new FakeLocator({ text: "986" }),
  });
  const mismatchedResult = await new BrowserExecutor({
    controller: new FakeController(mismatchedOrder),
  }).reconcileOrder({ itemId: "12345", orderId: "987" });
  assert.equal(mismatchedResult.status, "unknown");
  assert.equal(mismatchedResult.reason, "order_id_mismatch");

  const matching = new FakePage("https://www.vinted.co.uk/orders/987", {
    '[data-testid="order-success"]': new FakeLocator({ text: "Order confirmed" }),
    '[data-testid="order-item-id"]': new FakeLocator({ text: "12345" }),
    '[data-testid="order-id"]': new FakeLocator({ text: "987" }),
  });
  assert.deepEqual(
    await new BrowserExecutor({ controller: new FakeController(matching) }).reconcileOrder({
      itemId: "12345",
      orderId: "987",
    }),
    {
      ok: true,
      status: "success",
      outcome: "succeeded",
      itemId: "12345",
      orderId: "987",
    },
  );
});
