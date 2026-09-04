/**
 * Values persisted in the local state machine. The states are intentionally
 * explicit: payment_submitted, confirming, and unknown are never retryable.
 */
export const ATTEMPT_STATES = Object.freeze({
  RECEIVED: "received",
  VALIDATED: "validated",
  QUEUED: "queued",
  LISTING_CHECKED: "listing_checked",
  CHECKOUT_OPENED: "checkout_opened",
  TOTAL_VERIFIED: "total_verified",
  PAYMENT_SUBMITTED: "payment_submitted",
  CONFIRMING: "confirming",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  UNKNOWN: "unknown",
  NEEDS_USER_ACTION: "needs_user_action",
  DRY_RUN: "dry_run",
  SKIPPED: "skipped",
});

export const EXECUTION_MODES = Object.freeze({
  DRY_RUN: "dry_run",
  HUMAN_FINAL: "human_final",
  AUTO_SUBMIT: "auto_submit",
});

export const RESERVATION_STATES = Object.freeze({
  RESERVED: "reserved",
  COMMITTED: "committed",
  RELEASED: "released",
  HELD: "held",
});

export const TERMINAL_STATES = new Set([
  ATTEMPT_STATES.SUCCEEDED,
  ATTEMPT_STATES.FAILED,
  ATTEMPT_STATES.DRY_RUN,
  ATTEMPT_STATES.SKIPPED,
]);

export const AMBIGUOUS_STATES = new Set([
  ATTEMPT_STATES.PAYMENT_SUBMITTED,
  ATTEMPT_STATES.CONFIRMING,
  ATTEMPT_STATES.UNKNOWN,
]);

/**
 * A payment state can only move forward. In particular, no path leaves
 * unknown, and no path re-enters queued from a payment state.
 */
export const ATTEMPT_TRANSITIONS = Object.freeze({
  [ATTEMPT_STATES.RECEIVED]: new Set([
    ATTEMPT_STATES.VALIDATED,
    ATTEMPT_STATES.SKIPPED,
    ATTEMPT_STATES.FAILED,
  ]),
  [ATTEMPT_STATES.VALIDATED]: new Set([
    ATTEMPT_STATES.QUEUED,
    ATTEMPT_STATES.SKIPPED,
    ATTEMPT_STATES.FAILED,
  ]),
  [ATTEMPT_STATES.QUEUED]: new Set([
    ATTEMPT_STATES.LISTING_CHECKED,
    ATTEMPT_STATES.FAILED,
    ATTEMPT_STATES.SKIPPED,
    ATTEMPT_STATES.NEEDS_USER_ACTION,
  ]),
  [ATTEMPT_STATES.LISTING_CHECKED]: new Set([
    ATTEMPT_STATES.CHECKOUT_OPENED,
    ATTEMPT_STATES.FAILED,
    ATTEMPT_STATES.NEEDS_USER_ACTION,
  ]),
  [ATTEMPT_STATES.CHECKOUT_OPENED]: new Set([
    ATTEMPT_STATES.TOTAL_VERIFIED,
    ATTEMPT_STATES.FAILED,
    ATTEMPT_STATES.NEEDS_USER_ACTION,
  ]),
  [ATTEMPT_STATES.TOTAL_VERIFIED]: new Set([
    ATTEMPT_STATES.PAYMENT_SUBMITTED,
    ATTEMPT_STATES.NEEDS_USER_ACTION,
    ATTEMPT_STATES.DRY_RUN,
    ATTEMPT_STATES.FAILED,
  ]),
  [ATTEMPT_STATES.PAYMENT_SUBMITTED]: new Set([
    ATTEMPT_STATES.CONFIRMING,
    ATTEMPT_STATES.NEEDS_USER_ACTION,
    ATTEMPT_STATES.UNKNOWN,
  ]),
  [ATTEMPT_STATES.CONFIRMING]: new Set([
    ATTEMPT_STATES.SUCCEEDED,
    ATTEMPT_STATES.FAILED,
    ATTEMPT_STATES.NEEDS_USER_ACTION,
    ATTEMPT_STATES.UNKNOWN,
  ]),
  [ATTEMPT_STATES.NEEDS_USER_ACTION]: new Set([
    ATTEMPT_STATES.PAYMENT_SUBMITTED,
    ATTEMPT_STATES.CONFIRMING,
    ATTEMPT_STATES.SUCCEEDED,
    ATTEMPT_STATES.FAILED,
    ATTEMPT_STATES.UNKNOWN,
  ]),
  [ATTEMPT_STATES.SUCCEEDED]: new Set(),
  [ATTEMPT_STATES.FAILED]: new Set(),
  // Unknown can only move through read-only reconciliation. It can never
  // re-enter a payable or queued state.
  [ATTEMPT_STATES.UNKNOWN]: new Set([
    ATTEMPT_STATES.SUCCEEDED,
    ATTEMPT_STATES.FAILED,
    ATTEMPT_STATES.NEEDS_USER_ACTION,
  ]),
  [ATTEMPT_STATES.DRY_RUN]: new Set(),
  [ATTEMPT_STATES.SKIPPED]: new Set(),
});

export function assertAttemptTransition(from, to) {
  if (!ATTEMPT_TRANSITIONS[from]?.has(to)) {
    throw new Error(`Invalid attempt transition: ${from} -> ${to}`);
  }
}

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function isAmbiguousState(state) {
  return AMBIGUOUS_STATES.has(state);
}

export function utcNow() {
  return new Date().toISOString();
}

export function utcDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError(`Invalid date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

export function normalizeIdentifier(value, field = "identifier") {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new TypeError(`${field} must be a non-empty string or safe integer`);
}
