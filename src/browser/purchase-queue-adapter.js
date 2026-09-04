import {
  PAYMENT_OUTCOMES,
  RECONCILE_OUTCOMES,
} from "../core/browser-executor.js";
import { BrowserAutomationError } from "./errors.js";
import { isAllowedListingUrl } from "./selectors.js";

const CHALLENGE_STATES = new Set([
  "login_required",
  "captcha",
  "verification_required",
]);
const PAYMENT_CALL_CROSSED_REASONS = new Set([
  "payment_submitted_reconcile_required",
  "payment_submission_uncertain_reconcile_required",
]);

function asItemId(value) {
  const itemId = String(value ?? "").trim();
  return /^\d+$/.test(itemId) ? itemId : null;
}

function asOrderId(value) {
  const orderId = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(orderId) ? orderId : null;
}

function asCurrency(value) {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function asMinor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function adapterError(phase, reason, result) {
  return new BrowserAutomationError(`${phase}: ${reason}`, {
    code: `BROWSER_ADAPTER_${String(phase).toUpperCase()}_FAILED`,
    cause: result instanceof Error ? result : undefined,
  });
}

function challengeReason(result) {
  return result?.reason ?? result?.status ?? "user_action_required";
}

function isChallenge(result) {
  return CHALLENGE_STATES.has(result?.status) || result?.status === "user_action_required";
}

/**
 * Adapts the selector-level BrowserExecutor to PurchaseQueue's durable
 * contract. The queue's attempt rows intentionally omit listing URLs, so the
 * lookup is the only source for the stored URL, item price, and currency.
 * Every non-OK pre-payment result becomes a thrown error (the queue marks it
 * failed before the payment boundary); challenge states are translated to a
 * deliberate needs_user_action result. No method retries or clicks on an
 * unknown result.
 */
export class PurchaseQueueBrowserAdapter {
  #itemCache = new Map();

  constructor({ executor, itemLookup } = {}) {
    if (!executor || typeof executor !== "object") {
      throw new TypeError("PurchaseQueueBrowserAdapter requires an executor");
    }
    const required = [
      "openListing",
      "inspectListing",
      "openCheckout",
      "inspectCheckout",
      "readCheckout",
      "submitPayment",
      "reconcileOrder",
    ];
    for (const method of required) {
      if (typeof executor[method] !== "function") {
        throw new TypeError(`PurchaseQueueBrowserAdapter executor is missing ${method}()`);
      }
    }
    if (typeof itemLookup !== "function") {
      throw new TypeError("PurchaseQueueBrowserAdapter requires an itemLookup function");
    }
    this.executor = executor;
    this.itemLookup = itemLookup;
  }

  async #storedItem(attempt) {
    const key = String(attempt?.itemKey ?? attempt?.attemptId ?? "").trim();
    if (!key) throw adapterError("lookup", "attempt_item_key_missing");
    if (this.#itemCache.has(key)) return this.#itemCache.get(key);

    let raw;
    try {
      raw = await this.itemLookup({
        attempt,
        itemKey: key,
        itemId: attempt?.itemId,
      });
    } catch (error) {
      throw adapterError("lookup", "item_lookup_failed", error);
    }
    const item = normalizeStoredItem(raw, attempt);
    this.#itemCache.set(key, item);
    return item;
  }

  async openListing(attempt, context = {}) {
    const item = await this.#storedItem(attempt);
    const result = await this.#call("openListing", {
      url: item.url,
      itemId: item.itemId,
      expectedPriceMinor: item.priceMinor,
      expectedCurrency: item.currency,
    }, context);
    if (isChallenge(result)) {
      await this.#requestUserAction(result);
      return toNeedsUserAction(result);
    }
    requireOk(result, "open_listing");
    return {
      ok: true,
      itemId: item.itemId,
      priceMinor: item.priceMinor,
      currency: item.currency,
      url: item.url,
      browserStatus: result.status,
    };
  }

  async inspectListing(attempt, context = {}) {
    const item = await this.#storedItem(attempt);
    const result = await this.#call("inspectListing", {
      itemId: item.itemId,
      expectedPriceMinor: item.priceMinor,
      expectedCurrency: item.currency,
    }, context);
    requireOkOrChallenge(result, "inspect_listing");
    if (isChallenge(result)) {
      await this.#requestUserAction(result);
      return toNeedsUserAction(result);
    }
    const listing = result.listing;
    if (!listing || listing.itemId !== item.itemId || listing.available !== true) {
      throw adapterError("inspect_listing", "listing_shape_unverified", result);
    }
    if (
      listing.price?.amountMinor !== item.priceMinor ||
      listing.price?.currency !== item.currency
    ) {
      throw adapterError("inspect_listing", "listing_price_or_currency_changed", result);
    }
    return {
      ok: true,
      available: true,
      itemId: listing.itemId,
      priceMinor: listing.price.amountMinor,
      currency: listing.price.currency,
      browserStatus: result.status,
    };
  }

  async openCheckout(attempt, context = {}) {
    const item = await this.#storedItem(attempt);
    const result = await this.#call("openCheckout", { itemId: item.itemId }, context);
    requireOkOrChallenge(result, "open_checkout");
    if (isChallenge(result)) {
      await this.#requestUserAction(result);
      return toNeedsUserAction(result);
    }
    if (result.itemId !== undefined && String(result.itemId) !== item.itemId) {
      throw adapterError("open_checkout", "checkout_item_mismatch", result);
    }
    return {
      ok: true,
      itemId: item.itemId,
      browserStatus: result.status,
    };
  }

  async inspectCheckout(attempt, context = {}) {
    const item = await this.#storedItem(attempt);
    const expectedTotalMinor = context.expectedTotalMinor ?? context.maxCheckoutTotalMinor;
    const result = await this.#call("inspectCheckout", {
      itemId: item.itemId,
      ...(expectedTotalMinor === undefined ? {} : { expectedTotalMinor }),
      expectedCurrency: item.currency,
    }, context);
    requireOkOrChallenge(result, "inspect_checkout");
    if (isChallenge(result)) {
      await this.#requestUserAction(result);
      return toNeedsUserAction(result);
    }
    return mapCheckout(result, item);
  }

  /** Core PurchaseQueue spelling; it intentionally delegates to the same
   * safe inspect path rather than exposing a second DOM implementation. */
  async readCheckout(attempt, context = {}) {
    const result = await this.inspectCheckout(attempt, context);
    if (result?.needsUserAction) return result;
    return result;
  }

  async submitPayment(attempt, context = {}) {
    const item = await this.#storedItem(attempt);
    const result = await this.#call("submitPayment", { itemId: item.itemId }, context);
    if (isChallenge(result)) {
      await this.#requestUserAction(result);
      return {
        outcome: PAYMENT_OUTCOMES.NEEDS_USER_ACTION,
        reason: challengeReason(result),
      };
    }
    if (result?.ok && result.status === "success" && result.outcome === "submitted") {
      return {
        outcome: PAYMENT_OUTCOMES.SUBMITTED,
        orderId: result.orderId ?? null,
      };
    }
    // The safe executor sets these reasons only after it has crossed or may
    // have crossed the irreversible button. Tell the core to reconcile once;
    // returning UNKNOWN here would skip that one safe reconciliation pass.
    if (PAYMENT_CALL_CROSSED_REASONS.has(result?.reason)) {
      return {
        outcome: PAYMENT_OUTCOMES.SUBMITTED,
        orderId: null,
      };
    }
    // At this point the queue has persisted its final payment boundary. Even
    // a button that looked unavailable must therefore remain ambiguous.
    return {
      outcome: PAYMENT_OUTCOMES.UNKNOWN,
      reason: result?.reason ?? result?.status ?? "payment_outcome_unknown",
    };
  }

  async reconcileOrder(attempt, context = {}) {
    const item = await this.#storedItem(attempt);
    const expectedOrderId = asOrderId(attempt?.orderId ?? item.orderId);
    const result = await this.#call(
      "reconcileOrder",
      {
        itemId: item.itemId,
        ...(expectedOrderId ? { orderId: expectedOrderId } : {}),
      },
      context,
    );
    if (result?.ok && result.status === "success" && result.outcome === "succeeded") {
      return {
        outcome: RECONCILE_OUTCOMES.SUCCEEDED,
        orderId: result.orderId ?? null,
        reason: "order_confirmed",
      };
    }
    if (isChallenge(result)) {
      await this.#requestUserAction(result);
      return {
        outcome: RECONCILE_OUTCOMES.NEEDS_USER_ACTION,
        reason: challengeReason(result),
      };
    }
    if (result?.status === "failed" && result.ok === false) {
      return {
        outcome: RECONCILE_OUTCOMES.FAILED,
        reason: result.reason ?? "order_failed",
      };
    }
    return {
      outcome: RECONCILE_OUTCOMES.UNKNOWN,
      reason: result?.reason ?? result?.status ?? "order_state_unknown",
    };
  }

  async requestUserAction(input) {
    return this.executor.requestUserAction(input);
  }

  async close() {
    return this.executor.close();
  }

  async #call(method, input, context) {
    try {
      return await this.executor[method](input, context);
    } catch (error) {
      throw adapterError(method, "executor_failed", error);
    }
  }

  async #requestUserAction(result) {
    if (typeof this.executor.requestUserAction !== "function") return;
    try {
      await this.executor.requestUserAction({ reason: challengeReason(result) });
    } catch {
      // The safe result remains needs_user_action/unknown; never turn a
      // foregrounding failure into an automatic retry.
    }
  }
}

function normalizeStoredItem(raw, attempt) {
  if (!raw || typeof raw !== "object") {
    throw adapterError("lookup", "stored_item_missing");
  }
  const itemId = asItemId(raw.itemId ?? raw.item_id ?? attempt?.itemId);
  const url = String(raw.url ?? raw.itemUrl ?? raw.item_url ?? "").trim();
  const priceMinor = asMinor(raw.priceMinor ?? raw.price_minor ?? raw.itemPriceMinor);
  const currency = asCurrency(raw.currency ?? attempt?.currency);
  const orderId = asOrderId(raw.orderId ?? raw.order_id ?? attempt?.orderId);
  if (
    !itemId ||
    !isAllowedListingUrl(url, itemId) ||
    priceMinor === null ||
    !currency
  ) {
    throw adapterError("lookup", "stored_item_fields_invalid");
  }
  return { itemId, url, priceMinor, currency, ...(orderId ? { orderId } : {}) };
}

function requireOk(result, phase) {
  if (!result?.ok) {
    if (isChallenge(result)) throw adapterError(phase, `challenge_${result.status}`, result);
    throw adapterError(phase, result?.reason ?? result?.status ?? "unknown_result", result);
  }
}

function requireOkOrChallenge(result, phase) {
  if (!result?.ok && !isChallenge(result)) {
    throw adapterError(phase, result?.reason ?? result?.status ?? "unknown_result", result);
  }
}

function toNeedsUserAction(result) {
  return {
    needsUserAction: true,
    reason: challengeReason(result),
    status: result.status,
  };
}

function mapCheckout(result, item) {
  const checkout = result.checkout;
  const totalMinor = asMinor(checkout?.total?.amountMinor ?? checkout?.totalMinor);
  const currency = asCurrency(checkout?.total?.currency ?? checkout?.currency);
  if (
    !checkout ||
    checkout.itemId !== item.itemId ||
    totalMinor === null ||
    currency !== item.currency ||
    !checkout.paymentMethodLabel
  ) {
    throw adapterError("inspect_checkout", "checkout_shape_unverified", result);
  }
  return {
    ok: true,
    itemId: checkout.itemId,
    itemPriceMinor: item.priceMinor,
    totalMinor,
    currency,
    paymentMethodLabel: checkout.paymentMethodLabel,
    browserStatus: result.status,
  };
}
