import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowserExecutor } from "../../src/browser/browser-executor.js";
import { isAllowedCheckoutUrl, VINTED_SELECTORS } from "../../src/browser/selectors.js";

class EmptyLocator {
  first() { return this; }
  async count() { return 0; }
}

class FakeLocator {
  constructor({ text = "", visible = true, enabled = true, onClick, parent } = {}) {
    this.value = text;
    this.visible = visible;
    this.enabled = enabled;
    this.onClick = onClick;
    this.parent = parent;
    this.clicks = 0;
  }
  first() { return this; }
  async count() { return 1; }
  async textContent() { return this.value; }
  async getAttribute() { return null; }
  async isVisible() { return this.visible; }
  async isEnabled() { return this.enabled; }
  async click() {
    this.clicks += 1;
    await this.onClick?.();
  }
  locator(selector) {
    return selector === "xpath=.." ? this.parent : new EmptyLocator();
  }
  getByText(value) {
    return this.parent?.getByText(value) ?? new EmptyLocator();
  }
}

class MultiLocator {
  constructor(locators) { this.locators = locators; }
  first() { return this.locators[0]; }
  async count() { return this.locators.length; }
  nth(index) { return this.locators[index]; }
}

class SemanticPage {
  constructor(url, { title = "Nike trainers", price = "£8.00", total = "£9.10", removed = false,
    prices, buyCount = 1, payment = "Bank card Use a credit or debit card", setup = false,
    totalCount = 1, payCount = 1, loggedOut = false } = {}) {
    this.currentUrl = url;
    this.title = title;
    this.price = price;
    this.total = total;
    this.prices = prices ?? (price ? [price] : []);
    this.removed = removed;
    this.payment = payment;
    this.setup = setup;
    this.loggedOut = loggedOut;
    this.buy = new FakeLocator();
    this.buyCount = buyCount;
    this.totalCount = totalCount;
    this.payCount = payCount;
    this.paymentCount = 1;
    this.pay = new FakeLocator();
    this.heading = new FakeLocator({ text: "Total to pay" });
    this.heading.parent = {
      getByText: (value) => {
        if (value instanceof RegExp && this.totalCount > 1) {
          return new MultiLocator([
            new FakeLocator({ text: this.total }),
            new FakeLocator({ text: this.total }),
          ]);
        }
        return value instanceof RegExp && this.total
          ? new FakeLocator({ text: this.total })
          : new EmptyLocator();
      },
    };
    this.buy.onClick = async () => {
      this.currentUrl = "https://www.vinted.co.uk/checkout?item_id=12345";
    };
  }
  url() { return this.currentUrl; }
  async goto(url) { this.currentUrl = url; }
  async waitForLoadState() {}
  locator(selector) {
    // The live contract intentionally has no data-test ID dependency.  Keep
    // these selectors empty so a test cannot pass through a stale selector.
    return new EmptyLocator();
  }
  getByRole(role, options = {}) {
    const name = options.name;
    if (role === "heading" && options.level === 1) {
      return new FakeLocator({ text: this.title });
    }
    if (role === "heading" && name === "Total to pay") {
      return this.totalCount > 1
        ? new MultiLocator([this.heading, new FakeLocator({ text: "Total to pay" })])
        : this.heading;
    }
    if (role === "button" && name === "Buy now") {
      if (this.buyCount > 1) return new MultiLocator([this.buy, new FakeLocator()]);
      return this.removed ? new EmptyLocator() : this.buy;
    }
    if (role === "button" && name === "Pay") {
      if (this.payCount > 1) return new MultiLocator([this.pay, new FakeLocator()]);
      return this.setup ? new EmptyLocator() : this.pay;
    }
    if (role === "radio" && name === "Bank card Use a credit or debit card") {
      return this.payment ? new FakeLocator({ text: this.payment }) : new EmptyLocator();
    }
    if ((role === "button" || role === "link") && name === "Add your address") {
      return this.setup ? new FakeLocator({ text: "Add your address" }) : new EmptyLocator();
    }
    if (role === "link" && name === "Sign up | Log in") {
      return this.loggedOut ? new FakeLocator({ text: "Sign up | Log in" }) : new EmptyLocator();
    }
    return new EmptyLocator();
  }
  getByText(value) {
    if (typeof value === "string") {
      if (value === "Removed!") return this.removed ? new FakeLocator({ text: "Removed!" }) : new EmptyLocator();
      if (value === "Add your address") return this.setup ? new FakeLocator({ text: value }) : new EmptyLocator();
      if (value === this.payment) return new FakeLocator({ text: this.payment });
      return new EmptyLocator();
    }
    if (value instanceof RegExp) {
      if (this.prices.length === 0) return new EmptyLocator();
      if (this.prices.length === 1) return new FakeLocator({ text: this.prices[0] });
      return new MultiLocator(this.prices.map((item) => new FakeLocator({ text: item })));
    }
    return new EmptyLocator();
  }
}

class FakeController {
  constructor(page) { this.currentPage = page; }
  async navigate(url) { await this.currentPage.goto(url); return this.currentPage; }
  async page() { return this.currentPage; }
}

const listingUrl = "https://www.vinted.co.uk/items/12345-nike-trainers";

function executorFor(page) {
  return new BrowserExecutor({ controller: new FakeController(page) });
}

async function openLiveListing(executor) {
  return executor.openListing({
    url: listingUrl,
    itemId: "12345",
    expectedPriceMinor: 800,
    expectedCurrency: "GBP",
  });
}

test("live listing selectors verify URL identity, GBP price, and exact Buy now without paying", async () => {
  const page = new SemanticPage(listingUrl, { prices: ["£8.00", "£9.10"] });
  const executor = executorFor(page);
  assert.deepEqual(await openLiveListing(executor), {
    ok: true,
    status: "listing_opened",
    itemId: "12345",
  });
  assert.deepEqual((await executor.inspectListing({ itemId: "12345" })).listing, {
    itemId: "12345",
    available: true,
    price: { amountMinor: 800, currency: "GBP" },
  });
  assert.deepEqual(await executor.openCheckout({ itemId: "12345" }), {
    ok: true,
    status: "checkout_opened",
    itemId: "12345",
  });
  const checkout = await executor.inspectCheckout({
    itemId: "12345",
    expectedTotalMinor: 910,
    expectedCurrency: "GBP",
  });
  assert.deepEqual(checkout.checkout, {
    itemId: "12345",
    total: { amountMinor: 910, currency: "GBP" },
    paymentMethodLabel: "Saved card",
  });
  assert.equal(page.pay.clicks, 0, "inspection must stop before Pay");
});

test("Removed! is an explicit negative listing signal", async () => {
  const page = new SemanticPage(listingUrl, { removed: true, price: null });
  const executor = executorFor(page);
  await openLiveListing(executor);
  assert.deepEqual(await executor.inspectListing({ itemId: "12345" }), {
    ok: false,
    status: "sold",
    reason: "listing_unavailable",
    itemId: "12345",
  });
});

test("the live logged-out header pauses for sign-in before evaluating the listing", async () => {
  const page = new SemanticPage(listingUrl, { loggedOut: true });
  const executor = executorFor(page);
  const result = await openLiveListing(executor);
  assert.equal(result.status, "login_required");
  assert.equal(result.reason, "login_required");
});

test("checkout requires the exact /checkout path and preserves its click guard", async () => {
  assert.equal(isAllowedCheckoutUrl("https://www.vinted.co.uk/checkout?item_id=12345"), true);
  assert.equal(isAllowedCheckoutUrl("https://www.vinted.co.uk/checkout/"), false);
  assert.equal(isAllowedCheckoutUrl("https://www.vinted.co.uk/orders/12345"), false);

  const page = new SemanticPage(listingUrl);
  page.buy.onClick = async () => { page.currentUrl = "https://www.vinted.co.uk/orders/12345"; };
  const executor = executorFor(page);
  await openLiveListing(executor);
  await executor.inspectListing({ itemId: "12345" });
  assert.equal((await executor.openCheckout({ itemId: "12345" })).reason, "checkout_path_unverified");
  assert.equal((await executor.openCheckout({ itemId: "12345" })).reason, "checkout_already_open");
  assert.equal(page.buy.clicks, 1);
});

test("checkout waits for delayed client-side navigation before checking its path", async () => {
  const page = new SemanticPage(listingUrl);
  let waitCalled = false;
  page.buy.onClick = async () => {};
  page.waitForURL = async (predicate, options) => {
    waitCalled = true;
    assert.equal(options.timeout, 15_000);
    page.currentUrl = "https://www.vinted.co.uk/checkout?item_id=12345";
    assert.equal(predicate(new URL(page.currentUrl)), true);
  };
  const executor = executorFor(page);
  await openLiveListing(executor);
  await executor.inspectListing({ itemId: "12345" });
  assert.equal((await executor.openCheckout({ itemId: "12345" })).status, "checkout_opened");
  assert.equal(waitCalled, true);
});

test("missing address is surfaced as user action before total/payment inspection", async () => {
  const page = new SemanticPage(listingUrl, { setup: true });
  const executor = executorFor(page);
  await openLiveListing(executor);
  await executor.inspectListing({ itemId: "12345" });
  await executor.openCheckout({ itemId: "12345" });
  const result = await executor.inspectCheckout({ itemId: "12345", expectedTotalMinor: 910, expectedCurrency: "GBP" });
  assert.equal(result.status, "needs_user_action");
  assert.equal(result.reason, "checkout_setup_required");
  assert.equal(page.pay.clicks, 0);
});

test("ambiguous or absent live evidence remains unknown", async () => {
  const absentPrice = new SemanticPage(listingUrl, { price: null });
  const absentExecutor = executorFor(absentPrice);
  await openLiveListing(absentExecutor);
  assert.equal((await absentExecutor.inspectListing({ itemId: "12345" })).reason, "listing_price_unverified");

  const ambiguousBuy = new SemanticPage(listingUrl, { buyCount: 2 });
  const ambiguousBuyExecutor = executorFor(ambiguousBuy);
  await openLiveListing(ambiguousBuyExecutor);
  assert.equal((await ambiguousBuyExecutor.inspectListing({ itemId: "12345" })).reason, "buy_action_unavailable");

  const conflictingPrice = new SemanticPage(listingUrl, { prices: ["£8.00", "£9.10"] });
  const conflictingPriceExecutor = executorFor(conflictingPrice);
  await openLiveListing(conflictingPriceExecutor);
  assert.equal((await conflictingPriceExecutor.inspectListing({ itemId: "12345", expectedPriceMinor: 700 })).reason, "listing_price_unverified");

  const duplicatePrice = new SemanticPage(listingUrl, { prices: ["£8.00", "£8.00"] });
  const duplicatePriceExecutor = executorFor(duplicatePrice);
  await openLiveListing(duplicatePriceExecutor);
  assert.equal((await duplicatePriceExecutor.inspectListing({ itemId: "12345" })).reason, "listing_price_unverified");

  const ambiguousTotal = new SemanticPage(listingUrl, { totalCount: 2 });
  const ambiguousTotalExecutor = executorFor(ambiguousTotal);
  await openLiveListing(ambiguousTotalExecutor);
  await ambiguousTotalExecutor.inspectListing({ itemId: "12345" });
  await ambiguousTotalExecutor.openCheckout({ itemId: "12345" });
  assert.equal((await ambiguousTotalExecutor.inspectCheckout({ itemId: "12345", expectedTotalMinor: 910, expectedCurrency: "GBP" })).reason, "checkout_total_unverified");
});

test("selector contract exposes semantic anchors for the live page", () => {
  assert.equal(VINTED_SELECTORS.listing.title[0].kind, "role");
  assert.equal(VINTED_SELECTORS.listing.buyButton[0].kind, "role");
  assert.equal(VINTED_SELECTORS.checkout.total[0].kind, "within-heading");
  assert.equal(VINTED_SELECTORS.checkout.paymentMethod[0].kind, "text");
  assert.equal(VINTED_SELECTORS.checkout.submitButton[0].kind, "role");
});
