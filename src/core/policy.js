import { EXECUTION_MODES, utcDayKey } from "./types.js";

export class PolicyRejection extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = "PolicyRejection";
    this.reason = reason;
    this.details = details;
  }
}

function asSet(values, field) {
  if (values === undefined || values === null) return new Set();
  if (!Array.isArray(values) && !(values instanceof Set)) {
    throw new TypeError(`${field} must be an array or Set`);
  }
  return new Set([...values].map((value) => String(value).trim().toUpperCase()).filter(Boolean));
}

function finitePositiveInteger(value, field, { allowZero = false } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${field} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return value;
}

function normalizeDate(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new PolicyRejection(`${field}_invalid`);
  return date;
}

function sameIdentifier(actual, allowed) {
  return allowed.has(String(actual).trim().toUpperCase());
}

export class PurchasePolicy {
  constructor({
    marketAllowlist = [],
    currencyAllowlist = [],
    searchAllowlist = [],
    maxEventAgeMs = 120_000,
    maxItemPriceMinor = null,
    maxCheckoutTotalMinor = null,
    maxDailySpendMinor = null,
    maxDailyCount = null,
    clock = () => new Date(),
  } = {}) {
    this.marketAllowlist = asSet(marketAllowlist, "marketAllowlist");
    this.currencyAllowlist = asSet(currencyAllowlist, "currencyAllowlist");
    this.searchAllowlist = asSet(searchAllowlist, "searchAllowlist");
    this.maxEventAgeMs = finitePositiveInteger(maxEventAgeMs, "maxEventAgeMs", { allowZero: true });
    this.maxItemPriceMinor = finitePositiveInteger(maxItemPriceMinor, "maxItemPriceMinor");
    this.maxCheckoutTotalMinor = finitePositiveInteger(maxCheckoutTotalMinor, "maxCheckoutTotalMinor");
    this.maxDailySpendMinor = finitePositiveInteger(maxDailySpendMinor, "maxDailySpendMinor");
    this.maxDailyCount = finitePositiveInteger(maxDailyCount, "maxDailyCount");
    this.clock = clock;
  }

  validateMode(mode) {
    if (!Object.values(EXECUTION_MODES).includes(mode)) {
      throw new PolicyRejection("mode_not_allowed", { mode });
    }
  }

  requiresArmed(mode) {
    this.validateMode(mode);
    return mode !== EXECUTION_MODES.DRY_RUN;
  }

  evaluateEvent(event, now = this.clock()) {
    const market = String(event.market ?? "").trim().toUpperCase();
    const currency = String(event.currency ?? "").trim().toUpperCase();
    const searchId = String(event.searchId ?? "").trim().toUpperCase();
    if (!this.marketAllowlist.has(market)) throw new PolicyRejection("market_not_allowed", { market });
    if (!this.currencyAllowlist.has(currency)) throw new PolicyRejection("currency_not_allowed", { currency });
    // An empty search allowlist means the bearer-token discovery scope: every
    // search returned by Vinotify is eligible. A non-empty list is retained as
    // a compatibility restriction for older configs that name search IDs.
    if (this.searchAllowlist.size > 0 && !this.searchAllowlist.has(searchId)) {
      throw new PolicyRejection("search_not_allowed", { searchId });
    }
    const detectedAt = normalizeDate(event.detectedAt, "detected_at");
    const age = now.valueOf() - detectedAt.valueOf();
    if (age < -30_000 || age > this.maxEventAgeMs) {
      throw new PolicyRejection("event_not_fresh", { ageMs: age, maxEventAgeMs: this.maxEventAgeMs });
    }
    if (!Array.isArray(event.items)) throw new PolicyRejection("items_invalid");
    return { ok: true, market, currency, searchId, ageMs: age };
  }

  evaluateItem(event, item, now = this.clock()) {
    const eventDecision = this.evaluateEvent(event, now);
    const market = String(item.market ?? event.market ?? "").trim().toUpperCase();
    const currency = String(item.currency ?? event.currency ?? "").trim().toUpperCase();
    if (market !== eventDecision.market || !this.marketAllowlist.has(market)) {
      throw new PolicyRejection("item_market_not_allowed", { market });
    }
    if (currency !== eventDecision.currency || !this.currencyAllowlist.has(currency)) {
      throw new PolicyRejection("item_currency_not_allowed", { currency });
    }
    if (!Number.isSafeInteger(item.priceMinor) || item.priceMinor < 0) {
      throw new PolicyRejection("item_price_invalid");
    }
    if (this.maxItemPriceMinor !== null && item.priceMinor > this.maxItemPriceMinor) {
      throw new PolicyRejection("item_price_exceeds_limit", {
        priceMinor: item.priceMinor,
        maxItemPriceMinor: this.maxItemPriceMinor,
      });
    }
    return { ok: true, ...eventDecision, market, currency, itemPriceMinor: item.priceMinor };
  }

  evaluateFinalTotal(attempt, checkout, now = this.clock()) {
    const expectedCurrency = String(attempt.currency ?? "").trim().toUpperCase();
    const actualCurrency = String(checkout.currency ?? "").trim().toUpperCase();
    if (!expectedCurrency || actualCurrency !== expectedCurrency) {
      throw new PolicyRejection("checkout_currency_mismatch", {
        expectedCurrency,
        actualCurrency,
      });
    }
    if (!Number.isSafeInteger(checkout.totalMinor) || checkout.totalMinor < 0) {
      throw new PolicyRejection("checkout_total_invalid");
    }
    if (this.maxCheckoutTotalMinor !== null && checkout.totalMinor > this.maxCheckoutTotalMinor) {
      throw new PolicyRejection("checkout_total_exceeds_limit", {
        totalMinor: checkout.totalMinor,
        maxCheckoutTotalMinor: this.maxCheckoutTotalMinor,
      });
    }
    if (checkout.itemId !== undefined && String(checkout.itemId) !== String(attempt.itemId)) {
      throw new PolicyRejection("checkout_item_mismatch");
    }
    if (checkout.itemPriceMinor !== undefined &&
        (!Number.isSafeInteger(checkout.itemPriceMinor) || checkout.itemPriceMinor < 0)) {
      throw new PolicyRejection("checkout_item_price_invalid");
    }
    if (checkout.itemPriceMinor !== undefined && checkout.itemPriceMinor !== attempt.itemPriceMinor) {
      throw new PolicyRejection("checkout_item_price_changed", {
        expectedItemPriceMinor: attempt.itemPriceMinor,
        actualItemPriceMinor: checkout.itemPriceMinor,
      });
    }
    return {
      ok: true,
      totalMinor: checkout.totalMinor,
      currency: actualCurrency,
      dayKey: utcDayKey(now),
    };
  }

  reservationAmountMinor(item) {
    // Reserve the configured checkout ceiling when available. This is
    // deliberately conservative because shipping/protection fees are unknown
    // until the browser reaches the real checkout page.
    return this.maxCheckoutTotalMinor ?? item.priceMinor;
  }

  checkDailyUsage({ spendMinor, count, now = this.clock() }) {
    if (this.maxDailySpendMinor !== null && spendMinor > this.maxDailySpendMinor) {
      throw new PolicyRejection("daily_spend_exceeds_limit", {
        spendMinor,
        maxDailySpendMinor: this.maxDailySpendMinor,
        dayKey: utcDayKey(now),
      });
    }
    if (this.maxDailyCount !== null && count >= this.maxDailyCount) {
      throw new PolicyRejection("daily_count_exceeds_limit", {
        count,
        maxDailyCount: this.maxDailyCount,
        dayKey: utcDayKey(now),
      });
    }
    return { ok: true };
  }
}
