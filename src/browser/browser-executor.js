import {
  classifyPageState,
  clickLocator,
  firstLocator,
  locatorIsEnabled,
  locatorIsVisible,
  pageUrl,
  readSelectorValues,
  readLocatorAttribute,
  readLocatorText,
} from "./dom.js";
import {
  isAllowedListingUrl,
  isAllowedVintedUrl,
  normalizeAvailability,
  normalizeCurrency,
  normalizeItemId,
  normalizeOrderId,
  normalizePaymentMethodLabel,
  parseMoney,
  VINTED_SELECTORS,
} from "./selectors.js";

const BLOCKED_STATES = new Set([
  "login_required",
  "captcha",
  "verification_required",
  "payment_pending",
  "success",
]);

function safeItemId(value) {
  const itemId = String(value ?? "").trim();
  return /^\d+$/.test(itemId) ? itemId : null;
}

function safeOrderId(value) {
  const orderId = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(orderId) ? orderId : null;
}

function parseItemIdentity({ text, "data-item-id": dataId, content }) {
  const attributeId = normalizeItemId({ dataId, content });
  const textId = normalizeItemId({ text });
  if (attributeId && textId && attributeId !== textId) return null;
  return attributeId ?? textId;
}

function parseOrderIdentity({ text, "data-order-id": dataId, content }) {
  const attributeId = normalizeOrderId({ dataId, content });
  const textId = normalizeOrderId({ text });
  if (attributeId && textId && attributeId !== textId) return null;
  return attributeId ?? textId;
}

function safeMinor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function expectedPriceFrom(input, fallback = {}) {
  const amountMinor = safeMinor(
    input?.expectedPriceMinor ?? input?.priceMinor ?? fallback.expectedPriceMinor,
  );
  const currency = normalizeCurrency(
    input?.expectedCurrency ?? input?.currency ?? fallback.expectedCurrency,
  );
  return { amountMinor, currency };
}

function blocked(state, extra = {}) {
  return {
    ok: false,
    status: state,
    reason: state,
    ...extra,
  };
}

function unknown(reason = "unknown_page", extra = {}) {
  return { ok: false, status: "unknown", reason, ...extra };
}

/**
 * Fail-closed browser adapter for one serial purchase attempt.  The class
 * never reads browser storage, cookies, card inputs, or arbitrary checkout
 * DOM.  It returns only coarse payment-method labels and integer amounts.
 */
export class BrowserExecutor {
  #listing = null;
  #checkout = null;
  #paymentAttempted = false;

  constructor({ controller, clock = () => Date.now() } = {}) {
    if (!controller) throw new TypeError("BrowserExecutor requires a controller");
    this.controller = controller;
    this.clock = clock;
  }

  async #page() {
    try {
      return await this.controller.page();
    } catch {
      return null;
    }
  }

  async #state(page) {
    if (!page) return "unknown";
    const url = await pageUrl(page);
    if (!isAllowedVintedUrl(url)) return "unknown";
    try {
      return await classifyPageState(page);
    } catch {
      return "unknown";
    }
  }

  async #targetedState(page) {
    const state = await this.#state(page);
    return BLOCKED_STATES.has(state) ? state : null;
  }

  async openListing(input = {}, _context = {}) {
    const { url, itemId, expectedPriceMinor, expectedCurrency } = listingInput(input);
    if (this.#paymentAttempted) {
      return unknown("payment_attempt_already_made");
    }
    const normalizedItemId = safeItemId(itemId);
    if (!normalizedItemId || !isAllowedListingUrl(url, normalizedItemId)) {
      return unknown("listing_url_or_item_mismatch");
    }

    const expected = expectedPriceFrom({ expectedPriceMinor, expectedCurrency });
    if (expected.amountMinor === null || !expected.currency) {
      return unknown("expected_price_required");
    }

    try {
      const page = await this.controller.navigate(url);
      const state = await this.#state(page);
      if (BLOCKED_STATES.has(state)) return blocked(state, { itemId: normalizedItemId });
      if (state !== "unknown") return unknown("unexpected_listing_state");
      this.#listing = {
        itemId: normalizedItemId,
        url,
        expectedPriceMinor: expected.amountMinor,
        expectedCurrency: expected.currency,
        verified: false,
        openedAt: this.clock(),
      };
      this.#checkout = null;
      return {
        ok: true,
        status: "listing_opened",
        itemId: normalizedItemId,
      };
    } catch {
      return unknown("listing_navigation_failed");
    }
  }

  async inspectListing(input = {}, context = {}) {
    const { itemId, expectedPriceMinor, expectedCurrency } = listingInput(input, context);
    const normalizedItemId = safeItemId(itemId ?? this.#listing?.itemId);
    if (!this.#listing || !normalizedItemId || this.#listing.itemId !== normalizedItemId) {
      return unknown("listing_not_open");
    }

    const expected = expectedPriceFrom(
      { expectedPriceMinor, expectedCurrency },
      this.#listing,
    );
    if (expected.amountMinor === null || !expected.currency) {
      return unknown("expected_price_required");
    }

    const page = await this.#page();
    if (!page) return unknown("browser_unavailable");
    const currentUrl = await pageUrl(page);
    if (!isAllowedListingUrl(currentUrl, normalizedItemId)) {
      return unknown("listing_url_or_item_mismatch");
    }
    const state = await this.#targetedState(page);
    if (state) return blocked(state, { itemId: normalizedItemId });

    const idMatch = await firstLocator(page, VINTED_SELECTORS.listing.id);
    const id = normalizeItemId({
      text: await readLocatorText(idMatch?.locator),
      dataId: await readLocatorAttribute(idMatch?.locator, "data-item-id"),
      content: await readLocatorAttribute(idMatch?.locator, "content"),
    });
    if (!id || id !== normalizedItemId) {
      return unknown("listing_id_unverified", { itemId: normalizedItemId });
    }

    const availabilityMatch = await firstLocator(
      page,
      VINTED_SELECTORS.listing.availability,
    );
    const availability = normalizeAvailability({
      text: await readLocatorText(availabilityMatch?.locator),
      availableAttribute: await readLocatorAttribute(
        availabilityMatch?.locator,
        "data-available",
      ),
    });
    if (availability === false) {
      return { ok: false, status: "sold", reason: "listing_unavailable", itemId: normalizedItemId };
    }
    if (availability !== true) {
      return unknown("listing_availability_unverified", { itemId: normalizedItemId });
    }

    const priceMatch = await firstLocator(page, VINTED_SELECTORS.listing.price);
    const currencyMatch = await firstLocator(page, VINTED_SELECTORS.listing.currency);
    const price = parseMoney({
      text: await readLocatorText(priceMatch?.locator),
      amountAttribute:
        (await readLocatorAttribute(priceMatch?.locator, "content")) ??
        (await readLocatorAttribute(priceMatch?.locator, "data-price")) ??
        "",
      currencyAttribute:
        (await readLocatorAttribute(priceMatch?.locator, "data-currency")) ??
        (await readLocatorAttribute(currencyMatch?.locator, "content")) ??
        (await readLocatorText(currencyMatch?.locator)) ??
        "",
    });
    if (!price) return unknown("listing_price_unverified", { itemId: normalizedItemId });
    if (
      price.amountMinor !== expected.amountMinor ||
      price.currency !== expected.currency
    ) {
      return {
        ok: false,
        status: "price_changed",
        reason: "live_price_mismatch",
        itemId: normalizedItemId,
        livePrice: price,
      };
    }

    const buyButton = await firstLocator(page, VINTED_SELECTORS.listing.buyButton);
    if (
      !buyButton ||
      !(await locatorIsVisible(buyButton.locator)) ||
      !(await locatorIsEnabled(buyButton.locator))
    ) {
      return unknown("buy_action_unavailable", { itemId: normalizedItemId });
    }

    this.#listing = {
      ...this.#listing,
      expectedPriceMinor: expected.amountMinor,
      expectedCurrency: expected.currency,
      verified: true,
      available: true,
      livePrice: price,
    };
    return {
      ok: true,
      status: "listing_verified",
      listing: {
        itemId: normalizedItemId,
        available: true,
        price,
      },
    };
  }

  async openCheckout(input = {}, _context = {}) {
    const normalizedItemId = safeItemId(input.itemId ?? this.#listing?.itemId);
    if (
      !this.#listing ||
      !normalizedItemId ||
      normalizedItemId !== this.#listing.itemId ||
      !this.#listing.verified
    ) {
      return unknown("listing_not_verified");
    }
    if (this.#checkout?.buyClicked) return unknown("checkout_already_open");

    const page = await this.#page();
    if (!page) return unknown("browser_unavailable");
    const state = await this.#targetedState(page);
    if (state) return blocked(state, { itemId: normalizedItemId });
    if (!(await isAllowedListingUrlSafe(page, normalizedItemId))) {
      return unknown("listing_url_or_item_mismatch");
    }
    const buyButton = await firstLocator(page, VINTED_SELECTORS.listing.buyButton);
    if (
      !buyButton ||
      !(await locatorIsVisible(buyButton.locator)) ||
      !(await locatorIsEnabled(buyButton.locator))
    ) {
      return unknown("buy_action_unavailable", { itemId: normalizedItemId });
    }

    // Set the guard before the click.  A renderer crash during the click must
    // not cause a second click after a restart of the calling state machine.
    this.#checkout = { buyClicked: true, inspected: false };
    try {
      await clickLocator(buyButton.locator);
      if (typeof page.waitForLoadState === "function") {
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    } catch {
      return unknown("checkout_navigation_uncertain", { itemId: normalizedItemId });
    }
    const currentUrl = await pageUrl(page);
    if (!isAllowedVintedUrl(currentUrl)) {
      return unknown("checkout_origin_blocked", { itemId: normalizedItemId });
    }
    const afterState = await this.#targetedState(page);
    if (afterState) return blocked(afterState, { itemId: normalizedItemId });
    return { ok: true, status: "checkout_opened", itemId: normalizedItemId };
  }

  async inspectCheckout(input = {}, context = {}) {
    const itemId = input.itemId ?? this.#listing?.itemId;
    const expectedTotalMinor =
      input.expectedTotalMinor ?? context.expectedTotalMinor ?? context.maxCheckoutTotalMinor;
    const expectedCurrency = input.expectedCurrency ?? context.expectedCurrency;
    const normalizedItemId = safeItemId(itemId ?? this.#listing?.itemId);
    if (
      !this.#listing ||
      !this.#checkout?.buyClicked ||
      !normalizedItemId ||
      normalizedItemId !== this.#listing.itemId
    ) {
      return unknown("checkout_not_open");
    }
    const totalExpected = expectedPriceFrom({ expectedPriceMinor: expectedTotalMinor, expectedCurrency });
    if (!totalExpected.currency) return unknown("expected_checkout_currency_required");
    const page = await this.#page();
    if (!page) return unknown("browser_unavailable");
    const currentUrl = await pageUrl(page);
    if (!isAllowedVintedUrl(currentUrl)) return unknown("checkout_origin_blocked");
    const state = await this.#targetedState(page);
    if (state) return blocked(state, { itemId: normalizedItemId });

    const totalMatch = await firstLocator(page, VINTED_SELECTORS.checkout.total);
    const currencyMatch = await firstLocator(page, VINTED_SELECTORS.checkout.currency);
    const total = parseMoney({
      text: await readLocatorText(totalMatch?.locator),
      amountAttribute:
        (await readLocatorAttribute(totalMatch?.locator, "content")) ??
        (await readLocatorAttribute(totalMatch?.locator, "data-total")) ??
        "",
      currencyAttribute:
        (await readLocatorAttribute(totalMatch?.locator, "data-currency")) ??
        (await readLocatorAttribute(currencyMatch?.locator, "content")) ??
        (await readLocatorText(currencyMatch?.locator)) ??
        "",
    });
    if (!total) return unknown("checkout_total_unverified", { itemId: normalizedItemId });
    if (
      total.currency !== totalExpected.currency ||
      (totalExpected.amountMinor !== null && total.amountMinor !== totalExpected.amountMinor)
    ) {
      return {
        ok: false,
        status: "total_changed",
        reason: "checkout_total_mismatch",
        itemId: normalizedItemId,
        liveTotal: total,
      };
    }

    const paymentMatch = await firstLocator(
      page,
      VINTED_SELECTORS.checkout.paymentMethod,
    );
    const paymentMethodLabel = normalizePaymentMethodLabel(
      await readLocatorText(paymentMatch?.locator),
    );
    if (!paymentMethodLabel) {
      return unknown("saved_payment_method_unverified", { itemId: normalizedItemId });
    }

    const submit = await firstLocator(page, VINTED_SELECTORS.checkout.submitButton);
    if (
      !submit ||
      !(await locatorIsVisible(submit.locator)) ||
      !(await locatorIsEnabled(submit.locator))
    ) {
      return unknown("payment_action_unavailable", { itemId: normalizedItemId });
    }

    this.#checkout = {
      ...this.#checkout,
      inspected: true,
      total,
      paymentMethodLabel,
    };
    return {
      ok: true,
      status: "checkout_verified",
      checkout: {
        itemId: normalizedItemId,
        total,
        paymentMethodLabel,
      },
    };
  }

  async submitPayment(input = {}, _context = {}) {
    const normalizedItemId = safeItemId(input.itemId ?? this.#listing?.itemId);
    if (
      !this.#checkout?.buyClicked ||
      !this.#checkout.inspected ||
      !this.#listing ||
      normalizedItemId !== this.#listing.itemId
    ) {
      return unknown("checkout_not_verified");
    }
    if (this.#paymentAttempted) {
      return blocked("payment_pending", {
        itemId: normalizedItemId,
        reason: "payment_attempt_already_made_reconcile_first",
        outcome: "unknown",
      });
    }
    const page = await this.#page();
    if (!page) return unknown("browser_unavailable");
    const state = await this.#targetedState(page);
    if (state) {
      const outcome = ["login_required", "captcha", "verification_required"].includes(state)
        ? "needs_user_action"
        : state === "payment_pending"
          ? "unknown"
          : undefined;
      return blocked(state, { itemId: normalizedItemId, ...(outcome ? { outcome } : {}) });
    }
    const submit = await firstLocator(page, VINTED_SELECTORS.checkout.submitButton);
    if (
      !submit ||
      !(await locatorIsVisible(submit.locator)) ||
      !(await locatorIsEnabled(submit.locator))
    ) {
      return unknown("payment_action_unavailable", { itemId: normalizedItemId });
    }

    this.#paymentAttempted = true;
    try {
      await clickLocator(submit.locator);
    } catch {
      return blocked("payment_pending", {
        itemId: normalizedItemId,
        reason: "payment_submission_uncertain_reconcile_required",
        outcome: "unknown",
      });
    }
    const afterState = await this.#targetedState(page);
    if (afterState === "success") {
      return {
        ok: true,
        status: "success",
        outcome: "submitted",
        itemId: normalizedItemId,
      };
    }
    if (afterState) {
      return blocked(afterState, {
        itemId: normalizedItemId,
        outcome: ["login_required", "captcha", "verification_required"].includes(afterState)
          ? "needs_user_action"
          : "unknown",
      });
    }
    return blocked("payment_pending", {
      itemId: normalizedItemId,
      reason: "payment_submitted_reconcile_required",
      outcome: "unknown",
    });
  }

  async reconcileOrder(input = {}, context = {}) {
    const normalizedItemId = safeItemId(input.itemId ?? this.#listing?.itemId);
    if (!normalizedItemId) return unknown("item_id_missing");
    const rawExpectedOrderId =
      input.orderId ?? input.order_id ?? context.orderId ?? context.order_id;
    const expectedOrderId = safeOrderId(rawExpectedOrderId);
    if (rawExpectedOrderId !== undefined && rawExpectedOrderId !== null && !expectedOrderId) {
      return unknown("order_id_invalid", { itemId: normalizedItemId });
    }
    // Reconciliation is intentionally independent of the in-memory listing
    // session. After a process restart the user can leave the visible browser
    // on an order/processing page and safely ask for a read-only classification
    // without reopening a listing or clicking anything.
    const page = await this.#page();
    if (!page) return unknown("browser_unavailable");
    const currentUrl = await pageUrl(page);
    if (!isAllowedVintedUrl(currentUrl)) return unknown("checkout_origin_blocked");
    const state = await this.#state(page);
    if (state === "success") {
      const itemEvidence = await readSelectorValues(
        page,
        VINTED_SELECTORS.reconciliation.itemId,
        {
          attributes: ["data-item-id", "content"],
          parse: parseItemIdentity,
        },
      );
      if (itemEvidence.ambiguous || itemEvidence.values.length !== 1) {
        return unknown("order_item_id_unverified", { itemId: normalizedItemId });
      }
      const observedItemId = itemEvidence.values[0];
      if (observedItemId !== normalizedItemId) {
        return unknown("order_item_id_mismatch", {
          itemId: normalizedItemId,
          observedItemId,
        });
      }

      const orderEvidence = await readSelectorValues(
        page,
        VINTED_SELECTORS.reconciliation.orderId,
        {
          attributes: ["data-order-id", "content"],
          parse: parseOrderIdentity,
        },
      );
      if (orderEvidence.ambiguous || orderEvidence.values.length > 1) {
        return unknown("order_id_unverified", { itemId: normalizedItemId });
      }
      const observedOrderId = orderEvidence.values[0] ?? null;
      if (expectedOrderId && observedOrderId !== expectedOrderId) {
        return unknown("order_id_mismatch", {
          itemId: normalizedItemId,
          expectedOrderId,
          ...(observedOrderId ? { observedOrderId } : {}),
        });
      }

      this.#resetAfterConfirmedSuccess();
      return {
        ok: true,
        status: "success",
        outcome: "succeeded",
        itemId: normalizedItemId,
        ...(observedOrderId ? { orderId: observedOrderId } : {}),
      };
    }
    if (state === "payment_pending") return blocked(state, { itemId: normalizedItemId, outcome: "unknown" });
    if (BLOCKED_STATES.has(state)) return blocked(state, { itemId: normalizedItemId, outcome: "needs_user_action" });
    return unknown("order_state_unverified", { itemId: normalizedItemId });
  }

  /**
   * Compatibility spelling for the durable core's readCheckout contract.
   * The public browser surface remains inspectCheckout; this translation
   * exposes only integer totals and the coarse payment label.
   */
  async readCheckout(attempt = {}, context = {}) {
    const result = await this.inspectCheckout(
      {
        itemId: attempt.itemId,
        expectedTotalMinor: context.expectedTotalMinor ?? context.maxCheckoutTotalMinor,
        expectedCurrency: context.expectedCurrency ?? attempt.currency,
      },
      context,
    );
    if (result.status === "login_required" || result.status === "captcha" || result.status === "verification_required") {
      return {
        needsUserAction: true,
        reason: result.reason,
        status: result.status,
        itemId: attempt.itemId,
      };
    }
    if (!result.ok) return result;
    return {
      ok: true,
      itemId: result.checkout.itemId,
      itemPriceMinor: this.#listing?.livePrice?.amountMinor,
      totalMinor: result.checkout.total.amountMinor,
      currency: result.checkout.total.currency,
      paymentMethodLabel: result.checkout.paymentMethodLabel,
    };
  }

  async requestUserAction({ reason } = {}) {
    const allowed = new Set(["login_required", "captcha", "verification_required"]);
    if (!allowed.has(reason)) return unknown("unsupported_user_action");
    try {
      await this.controller.bringToFront();
      return {
        ok: true,
        status: "user_action_required",
        reason,
        instruction:
          reason === "login_required"
            ? "Sign in in the visible Vinted window."
            : reason === "verification_required"
              ? "Complete Vinted's verification in the visible window."
              : "Complete the CAPTCHA in the visible window.",
      };
    } catch {
      return unknown("browser_unavailable");
    }
  }

  async close() {
    try {
      await this.controller.close();
      return { ok: true, status: "closed" };
    } catch {
      return unknown("browser_close_failed");
    }
  }

  #resetAfterConfirmedSuccess() {
    // A confirmed order is the only terminal point that releases the
    // single-payment guard. Pending, challenge, and unknown states retain all
    // guards so a caller cannot accidentally start another attempt or retry.
    this.#listing = null;
    this.#checkout = null;
    this.#paymentAttempted = false;
  }
}

async function isAllowedListingUrlSafe(page, itemId) {
  return isAllowedListingUrl(await pageUrl(page), itemId);
}

function listingInput(input = {}, context = {}) {
  return {
    url: input.url ?? input.itemUrl ?? input.item_url ?? context.url,
    itemId: input.itemId ?? input.item_id ?? context.itemId,
    expectedPriceMinor:
      input.expectedPriceMinor ?? input.priceMinor ?? input.itemPriceMinor ?? context.expectedPriceMinor,
    expectedCurrency:
      input.expectedCurrency ?? input.currency ?? context.expectedCurrency ?? context.currency,
  };
}
