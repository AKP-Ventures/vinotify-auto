/**
 * Browser-facing constants and pure DOM parsing helpers.
 *
 * The selector list is deliberately kept in its own module.  It is the only
 * place where the executor knows about Vinted's DOM, which makes selector
 * changes reviewable and lets tests exercise the parser with tiny HTML/fake
 * locator fixtures.
 */

export const VINTED_UK_ORIGIN = "https://www.vinted.co.uk";
export const VINTED_UK_HOST_ALLOWLIST = Object.freeze(["www.vinted.co.uk"]);

const freezeTree = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
};

// Playwright's semantic locator APIs are more stable than generated classes
// and test IDs.  These small descriptors keep that choice declarative while
// allowing the DOM adapter to provide CSS fallbacks to lightweight fixtures.
const role = (name, options = {}) => ({
  kind: "role",
  role: name,
  options,
});

const text = (value, options = {}) => ({
  kind: "text",
  value,
  options,
});

const MONEY_TEXT = /^[£€$]\s*\d+(?:,\d{3})*(?:\.\d{1,2})?$/;

const withinHeading = (name, options = {}) => ({
  kind: "within-heading",
  heading: name,
  options,
  pattern: MONEY_TEXT,
});

/**
 * Stable attributes are preferred.  The text/semantic fallbacks are kept
 * narrow on purpose: an unrecognised page must be treated as unknown rather
 * than guessed to be purchasable.
 */
export const VINTED_SELECTORS = freezeTree({
  page: {
    body: ["body"],
    login: [
      role("link", { name: "Sign up | Log in", exact: true }),
      '[data-testid="login-page"]',
      '[data-testid="login-form"]',
      'form[action*="/login"]',
      '[data-testid="session-expired"]',
    ],
    captcha: [
      '[data-testid="captcha"]',
      '[data-testid="captcha-challenge"]',
      'iframe[src*="captcha"]',
      '[aria-label*="captcha" i]',
    ],
    verification: [
      '[data-testid="purchase-verification"]',
      '[data-testid="payment-verification"]',
      '[data-testid="3ds-challenge"]',
      '[data-testid="identity-check"]',
    ],
    paymentPending: [
      '[data-testid="payment-pending"]',
      '[data-testid="order-processing"]',
      '[data-testid="purchase-processing"]',
    ],
    success: [
      '[data-testid="order-success"]',
      '[data-testid="purchase-confirmation"]',
      '[data-testid="order-confirmed"]',
    ],
  },
  listing: {
    root: [
      '[data-testid="item-page"]',
      '[data-testid="listing-page"]',
      '[data-item-id]',
      'main',
    ],
    title: [
      role("heading", { level: 1 }),
      'h1',
    ],
    id: [
      '[data-testid="item-id"]',
      '[data-item-id]',
      '[itemprop="productID"]',
    ],
    availability: [
      '[data-testid="item-availability"]',
      '[data-testid="listing-availability"]',
      '[data-testid="item-status"]',
      '[data-testid="item-sold"]',
      '[data-available]',
      text("Removed!", { exact: true }),
    ],
    price: [
      '[data-testid="item-price"]',
      '[data-testid="item-details__price"]',
      '[data-testid="listing-price"]',
      '[itemprop="price"]',
      text(MONEY_TEXT),
    ],
    currency: [
      '[data-testid="item-currency"]',
      '[data-testid="listing-currency"]',
      '[itemprop="priceCurrency"]',
    ],
    buyButton: [
      role("button", { name: "Buy now", exact: true }),
      '[data-testid="buy-button"]',
      '[data-testid="buy-now"]',
      '[data-testid="item-buy-button"]',
      'button[name="Buy now"]',
      'button[aria-label="Buy now"]',
      'button:text-is("Buy now")',
    ],
  },
  checkout: {
    root: [
      '[data-testid="checkout-page"]',
      '[data-testid="purchase-checkout"]',
    ],
    totalHeading: [
      role("heading", { name: "Total to pay", exact: true }),
      'h1:text-is("Total to pay")',
      'h2:text-is("Total to pay")',
      'h3:text-is("Total to pay")',
    ],
    total: [
      withinHeading("Total to pay", { exact: true }),
      '[data-testid="checkout-total"]',
      '[data-testid="order-total"]',
      '[data-testid="purchase-total"]',
      '[itemprop="totalPrice"]',
    ],
    currency: [
      '[data-testid="checkout-currency"]',
      '[data-testid="order-currency"]',
      '[itemprop="priceCurrency"]',
    ],
    paymentMethod: [
      text("Bank card Use a credit or debit card", { exact: true }),
      role("radio", { name: "Bank card Use a credit or debit card", exact: true }),
      '[data-testid="selected-payment-method"]',
      '[data-testid="saved-payment-method"]',
      '[data-testid="payment-method"]',
    ],
    setupRequired: [
      text("Add your address", { exact: true }),
      role("button", { name: "Add your address", exact: true }),
      role("link", { name: "Add your address", exact: true }),
    ],
    submitButton: [
      role("button", { name: "Pay", exact: true }),
      '[data-testid="submit-payment"]',
      'button:text-is("Pay")',
    ],
  },
  reconciliation: {
    // These selectors are deliberately identity-bearing.  A success banner
    // or an /orders/ URL alone is not evidence that the visible order belongs
    // to the payment attempt being reconciled.
    orderId: [
      '[data-testid="order-id"]',
      '[data-testid="order-number"]',
      '[data-order-id]',
      '[itemprop="orderNumber"]',
    ],
    itemId: [
      '[data-testid="order-item-id"]',
      '[data-testid="purchase-item-id"]',
      '[data-item-id]',
      '[itemprop="productID"]',
    ],
  },
});

export function isAllowedVintedUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === VINTED_UK_HOST_ALLOWLIST[0] &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.origin === VINTED_UK_ORIGIN
    );
  } catch {
    return false;
  }
}

export function extractListingId(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/items\/(\d+)(?:[-/]|$)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isAllowedListingUrl(value, itemId) {
  return (
    isAllowedVintedUrl(value) &&
    typeof itemId === "string" &&
    itemId.length > 0 &&
    extractListingId(value) === itemId
  );
}

/**
 * Checkout is a separate positive navigation boundary.  Same-origin pages
 * are not enough evidence after clicking Buy now; only Vinted's exact
 * `/checkout` path (with any query string) qualifies.
 */
export function isAllowedCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return isAllowedVintedUrl(value) && url.pathname === "/checkout";
  } catch {
    return false;
  }
}

export function normalizeCurrency(value) {
  const source = String(value ?? "").trim().toUpperCase();
  if (source === "£") return "GBP";
  if (source === "€") return "EUR";
  if (source === "$") return "USD";
  const normalized = source
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (normalized === "GBP" || normalized === "UKP") {
    return "GBP";
  }
  if (normalized === "EUR" || normalized === "€") return "EUR";
  if (normalized === "USD" || normalized === "$") return "USD";
  return null;
}

function currencyFromText(text) {
  const value = String(text ?? "");
  if (value.includes("£")) return "GBP";
  if (value.includes("€")) return "EUR";
  if (value.includes("$")) return "USD";
  const code = value.match(/\b(GBP|UKP|EUR|USD)\b/i)?.[1];
  return normalizeCurrency(code);
}

export function decimalToMinor(value) {
  const input = String(value ?? "").trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) return null;
  const [whole, decimal = ""] = input.split(".");
  const minor = Number(`${whole}${decimal.padEnd(2, "0")}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Parse a price only when a single, unambiguous amount is present.  Amounts
 * are returned as integer minor units so a float cannot affect the budget.
 */
export function parseMoney({ text = "", amountAttribute = "", currencyAttribute = "" } = {}) {
  const source = String(text ?? "").trim();
  const currency =
    normalizeCurrency(currencyAttribute) ?? currencyFromText(source);
  if (!currency) return null;

  const fromAttribute = decimalToMinor(amountAttribute);
  if (fromAttribute !== null) return { amountMinor: fromAttribute, currency };

  const numberMatches = source.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/g) ?? [];
  if (numberMatches.length !== 1) return null;
  const amountMinor = decimalToMinor(numberMatches[0].replace(",", "."));
  if (amountMinor === null) return null;
  return { amountMinor, currency };
}

export function normalizeItemId({ text = "", dataId = "", content = "" } = {}) {
  const direct = String(dataId || content || "").trim();
  if (/^\d+$/.test(direct)) return direct;
  const source = String(text ?? "");
  return source.match(/\b(?:item\s*id\s*[:#]?\s*)?(\d{2,})\b/i)?.[1] ?? null;
}

/**
 * Normalize an order identifier from an explicit order-identity element.
 * Order IDs are intentionally kept opaque: Vinted may use numeric or
 * delimiter-bearing identifiers, but never expose arbitrary DOM text to the
 * caller.  A bare text value is accepted only when the selector itself is an
 * identity selector; labelled text is supported for semantic fallbacks.
 */
export function normalizeOrderId({ text = "", dataId = "", content = "" } = {}) {
  const direct = String(dataId || content || "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(direct)) return direct;

  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  // Identity selectors commonly render a bare numeric ID.  Require either
  // two digits or an opaque token containing a digit/delimiter so a generic
  // word such as "confirmed" cannot become order evidence.
  if (/^\d{2,}$/.test(source) || /^(?=.{2,128}$)(?=.*[\d_-])[A-Za-z0-9][A-Za-z0-9_-]*$/.test(source)) {
    return source;
  }
  const match = source.match(
    /\b(?:order|purchase)\s*(?:id|number|no\.?|#)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_-]{0,127})\b/i,
  );
  return match?.[1] ?? null;
}

export function normalizeAvailability({ text = "", availableAttribute = "" } = {}) {
  const attribute = String(availableAttribute ?? "").trim().toLowerCase();
  if (attribute === "true" || attribute === "1") return true;
  if (attribute === "false" || attribute === "0") return false;

  const source = String(text ?? "").trim().toLowerCase();
  if (!source) return null;
  if (/\b(sold|reserved|unavailable|removed|not available)\b/.test(source)) {
    return false;
  }
  if (/\b(available|active|for sale)\b/.test(source)) return true;
  return null;
}

export function normalizePaymentMethodLabel(text) {
  const source = String(text ?? "").trim();
  if (!source) return null;

  // Never return a raw card label or a last-four/PAN-like value to callers.
  // The executor receives only one of these coarse labels.
  if (/\bbalance\b/i.test(source)) return "Vinted Balance";
  if (
    /\b(saved|stored|debit|credit|bank)\s+card\b/i.test(source) ||
    /\bcard\b/i.test(source)
  ) {
    return "Saved card";
  }
  return null;
}

export function classifyText(text, url = "") {
  const source = String(text ?? "").replace(/\s+/g, " ").trim();
  const lower = source.toLowerCase();
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (
    /captcha|security check|verify you are human/i.test(source) ||
    path.includes("captcha")
  ) {
    return "captcha";
  }
  if (
    /purchase verification|payment verification|identity check|3d secure|one[- ]time passcode|confirm (?:your )?payment/i.test(
      source,
    ) ||
    path.includes("verification") ||
    path.includes("3ds")
  ) {
    return "verification_required";
  }
  if (
    /payment (?:is )?pending|payment processing|processing (?:your )?payment|order processing|purchase processing/i.test(
      source,
    )
  ) {
    return "payment_pending";
  }
  if (
    /order confirmed|purchase confirmed|thank you for your purchase|purchase complete/i.test(
      source,
    ) ||
    path.includes("order-confirm") ||
    path.includes("purchase-confirm") ||
    path.includes("/orders/")
  ) {
    return "success";
  }
  if (
    /(?:please )?(?:sign in|log in) to continue|session expired|login required/i.test(
      source,
    ) ||
    path.endsWith("/login") ||
    path.includes("/login?")
  ) {
    return "login_required";
  }
  return "unknown";
}
