/**
 * The browser adapter is intentionally a contract rather than an implementation.
 * It must use the user's existing Vinted session and must never receive a
 * password, card number, CVV, OTP, or other payment secret from this core.
 */
export class BrowserExecutor {
  async openListing(_attempt, _context) {
    throw new Error("BrowserExecutor.openListing is not implemented");
  }

  async inspectListing(_attempt, _context) {
    throw new Error("BrowserExecutor.inspectListing is not implemented");
  }

  async openCheckout(_attempt, _context) {
    throw new Error("BrowserExecutor.openCheckout is not implemented");
  }

  async readCheckout(_attempt, _context) {
    throw new Error("BrowserExecutor.readCheckout is not implemented");
  }

  async submitPayment(_attempt, _context) {
    throw new Error("BrowserExecutor.submitPayment is not implemented");
  }

  async reconcileOrder(_attempt, _context) {
    throw new Error("BrowserExecutor.reconcileOrder is not implemented");
  }
}

const REQUIRED_METHODS = Object.freeze([
  "openListing",
  "inspectListing",
  "openCheckout",
  "readCheckout",
  "submitPayment",
  "reconcileOrder",
]);

export function assertBrowserExecutor(executor) {
  if (!executor || typeof executor !== "object") {
    throw new TypeError("A BrowserExecutor object is required");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof executor[method] !== "function") {
      throw new TypeError(`BrowserExecutor is missing ${method}()`);
    }
  }
  return executor;
}

export const PAYMENT_OUTCOMES = Object.freeze({
  SUBMITTED: "submitted",
  NEEDS_USER_ACTION: "needs_user_action",
  FAILED_BEFORE_SUBMIT: "failed_before_submit",
  UNKNOWN: "unknown",
});

export const RECONCILE_OUTCOMES = Object.freeze({
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  NEEDS_USER_ACTION: "needs_user_action",
  UNKNOWN: "unknown",
});
