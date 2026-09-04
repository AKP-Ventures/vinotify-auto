import {
  assertBrowserExecutor,
  PAYMENT_OUTCOMES,
  RECONCILE_OUTCOMES,
} from "./browser-executor.js";
import { PolicyRejection } from "./policy.js";
import {
  ATTEMPT_STATES,
  EXECUTION_MODES,
  RESERVATION_STATES,
  utcDayKey,
} from "./types.js";

function asErrorReason(error, fallback = "operation_failed") {
  if (error instanceof PolicyRejection) return resultReason(error.reason, fallback);
  // Browser adapters expose a deliberately allow-listed subreason while the
  // public error code remains phase-level. Prefer that stable detail, but do
  // not persist arbitrary exception messages (which may contain page data).
  return safeDiagnosticReason(error?.safeReason)
    ?? safeDiagnosticReason(error?.reason)
    ?? safeDiagnosticReason(error?.code)
    ?? safeDiagnosticReason(error?.message)
    ?? fallback;
}

const SAFE_REASON = /^[A-Za-z][A-Za-z0-9_]{0,95}$/;

function safeDiagnosticReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return SAFE_REASON.test(reason) ? reason : null;
}

function resultReason(value, fallback) {
  return safeDiagnosticReason(value) ?? fallback;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const metadata = {};
  for (const key of ["status", "outcome", "reason", "code"]) {
    const safe = safeDiagnosticReason(value[key]);
    if (safe) metadata[key] = safe;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function resultObject(value, field) {
  if (!value || typeof value !== "object") throw new Error(`${field} returned an invalid result`);
  return value;
}

/**
 * Serial, durable purchase worker. It owns orchestration but not browser
 * selectors. Every financial side effect is preceded by a persisted state
 * transition, so a crash after the final click becomes unknown rather than a
 * retried purchase.
 */
export class PurchaseQueue {
  constructor({ store, policy, executor, logger = null, clock = () => new Date() } = {}) {
    if (!store) throw new TypeError("store is required");
    if (!policy) throw new TypeError("policy is required");
    assertBrowserExecutor(executor);
    this.store = store;
    this.policy = policy;
    this.executor = executor;
    this.logger = logger;
    this.clock = clock;
    this.drainPromise = null;
    this.searchMembership = null;
    this.dryRunHeldAttemptId = null;
  }

  /**
   * Runtime-owned account scope. Once set, queued work must belong to the
   * latest successful discovery snapshot immediately before execution.
   */
  setSearchMembership({ accountFingerprint = null, searchIds, ready = true } = {}) {
    if (!Array.isArray(searchIds)) throw new TypeError("searchIds must be an array");
    this.searchMembership = {
      accountFingerprint: accountFingerprint ?? null,
      searchIds: new Set(searchIds.map((value) => String(value))),
      ready: Boolean(ready),
    };
    return this.searchMembership;
  }

  clearSearchMembership() {
    if (!this.searchMembership) return;
    this.searchMembership = { ...this.searchMembership, ready: false };
  }

  #isCurrentSearch(searchId) {
    if (!this.searchMembership) return true;
    return this.searchMembership.ready && this.searchMembership.searchIds.has(String(searchId));
  }

  #scopeUnavailable() {
    return Boolean(this.searchMembership && !this.searchMembership.ready);
  }

  #skipOutOfScopeAttempt(attempt, reason = "search_not_currently_discovered") {
    let skipped = attempt;
    if (attempt.state === ATTEMPT_STATES.QUEUED) {
      skipped = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.SKIPPED, { reason });
      this.store.markReservation?.(attempt.attemptId, RESERVATION_STATES.RELEASED);
    }
    this.log("attempt_skipped_out_of_scope", { attemptId: attempt.attemptId, searchId: attempt.searchId, reason });
    return { attempt: skipped, result: "skipped", reason };
  }

  #failOutOfScopeAttempt(attempt, reason = "search_not_currently_discovered") {
    let failed = attempt;
    if (![ATTEMPT_STATES.FAILED, ATTEMPT_STATES.DRY_RUN, ATTEMPT_STATES.SKIPPED].includes(attempt.state)) {
      failed = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.FAILED, { reason });
      this.store.markReservation?.(attempt.attemptId, RESERVATION_STATES.RELEASED);
    }
    this.log("attempt_failed", { attemptId: attempt.attemptId, searchId: attempt.searchId, reason });
    return { attempt: failed, result: "failed", reason };
  }

  getMode() {
    return this.store.getSetting("execution_mode", EXECUTION_MODES.DRY_RUN);
  }

  setMode(mode) {
    this.policy.validateMode(mode);
    this.store.setSetting("execution_mode", mode);
    // A mode change is the explicit operator action that may release a
    // dry-run checkout hold and allow another queued item to be opened.
    this.dryRunHeldAttemptId = null;
    this.log("mode_changed", { mode });
    return mode;
  }

  getArmState(now = this.clock()) {
    const value = this.store.getSetting("arm_state", { armedUntil: null, armedAt: null });
    const armedUntil = value?.armedUntil ?? null;
    const armed = Boolean(armedUntil && new Date(armedUntil).valueOf() > now.valueOf());
    return { armed, armedUntil, armedAt: value?.armedAt ?? null };
  }

  arm({ durationMs = 15 * 60 * 1000 } = {}) {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000) {
      throw new TypeError("durationMs must be a positive integer no longer than 24 hours");
    }
    const now = this.clock();
    const armState = { armedAt: now.toISOString(), armedUntil: new Date(now.valueOf() + durationMs).toISOString() };
    this.store.setSetting("arm_state", armState);
    this.log("agent_armed", { armedUntil: armState.armedUntil });
    return this.getArmState(now);
  }

  disarm(reason = "user_disarmed") {
    this.store.setSetting("arm_state", { armedAt: null, armedUntil: null });
    this.log("agent_disarmed", { reason });
    return this.getArmState();
  }

  log(event, fields = {}) {
    this.logger?.info(event, fields);
  }

  async enqueueEvent(event, { mode = this.getMode(), now = this.clock() } = {}) {
    this.policy.validateMode(mode);
    const created = [];
    const skipped = [];
    if (this.#scopeUnavailable()) {
      this.log("event_rejected", { eventId: event.eventId, reason: "account_scope_unavailable" });
      return { created, skipped, eventRejected: true, reason: "account_scope_unavailable" };
    }
    if (this.searchMembership && !this.#isCurrentSearch(event.searchId)) {
      for (const item of event.items ?? []) {
        if (this.store.getAttemptByItemKey(item.itemKey)) continue;
        const attempt = this.store.createAttempt({
          itemKey: item.itemKey,
          eventId: event.eventId,
          searchId: event.searchId,
          itemId: item.itemId,
          mode,
          state: ATTEMPT_STATES.SKIPPED,
          reason: "search_not_currently_discovered",
          market: item.market ?? event.market,
          currency: item.currency ?? event.currency,
          itemPriceMinor: item.priceMinor,
        });
        skipped.push(attempt);
      }
      this.log("event_rejected", { eventId: event.eventId, reason: "search_not_currently_discovered" });
      return { created, skipped, eventRejected: true, reason: "search_not_currently_discovered" };
    }
    let eventDecision;
    try {
      eventDecision = this.policy.evaluateEvent(event, now);
    } catch (error) {
      for (const item of event.items ?? []) {
        const itemKey = item.itemKey;
        if (!itemKey || this.store.getAttemptByItemKey(itemKey)) continue;
        const attempt = this.store.createAttempt({
          itemKey,
          eventId: event.eventId,
          searchId: event.searchId,
          itemId: item.itemId,
          mode,
          state: ATTEMPT_STATES.SKIPPED,
          reason: asErrorReason(error, "event_rejected"),
          market: item.market ?? event.market,
          currency: item.currency ?? event.currency,
          itemPriceMinor: item.priceMinor,
        });
        skipped.push(attempt);
      }
      this.log("event_rejected", { eventId: event.eventId, reason: asErrorReason(error) });
      return { created, skipped, eventRejected: true };
    }

    for (const item of event.items ?? []) {
      if (this.searchMembership && !this.#isCurrentSearch(item.searchId ?? event.searchId)) {
        if (!this.store.getAttemptByItemKey(item.itemKey)) {
          const attempt = this.store.createAttempt({
            itemKey: item.itemKey,
            eventId: event.eventId,
            searchId: item.searchId ?? event.searchId,
            itemId: item.itemId,
            mode,
            state: ATTEMPT_STATES.SKIPPED,
            reason: "search_not_currently_discovered",
            market: item.market ?? event.market,
            currency: item.currency ?? event.currency,
            itemPriceMinor: item.priceMinor,
          });
          skipped.push(attempt);
        }
        continue;
      }
      if (this.store.getAttemptByItemKey(item.itemKey)) continue;
      let decision;
      try {
        decision = this.policy.evaluateItem(event, item, now);
      } catch (error) {
        const attempt = this.store.createAttempt({
          itemKey: item.itemKey,
          eventId: event.eventId,
          searchId: event.searchId,
          itemId: item.itemId,
          mode,
          state: ATTEMPT_STATES.SKIPPED,
          reason: asErrorReason(error, "item_rejected"),
          market: item.market ?? event.market,
          currency: item.currency ?? event.currency,
          itemPriceMinor: item.priceMinor,
        });
        skipped.push(attempt);
        continue;
      }

      const attempt = this.store.createAttempt({
        itemKey: item.itemKey,
        eventId: event.eventId,
        searchId: event.searchId,
        itemId: item.itemId,
        mode,
        market: decision.market,
        currency: decision.currency,
        itemPriceMinor: item.priceMinor,
      });
      this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.VALIDATED);
      try {
        this.store.reserveBudget({
          attemptId: attempt.attemptId,
          amountMinor: this.policy.reservationAmountMinor(item),
          currency: item.currency,
          now,
          maxDailySpendMinor: this.policy.maxDailySpendMinor,
          maxDailyCount: this.policy.maxDailyCount,
        });
        const queued = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.QUEUED);
        created.push(queued);
      } catch (error) {
        this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.SKIPPED, {
          reason: asErrorReason(error, "budget_rejected"),
        });
        skipped.push(this.store.getAttempt(attempt.attemptId));
      }
    }
    this.log("event_enqueued", {
      eventId: event.eventId,
      createdCount: created.length,
      skippedCount: skipped.length,
    });
    return { created, skipped, eventRejected: false };
  }

  async drain({ signal } = {}) {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.#drain(signal).finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  async #drain(signal) {
    const processed = [];
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("queue_aborted");
      if (this.dryRunHeldAttemptId) {
        const held = this.store.getAttempt(this.dryRunHeldAttemptId);
        if (held?.state === ATTEMPT_STATES.DRY_RUN) {
          this.log("queue_blocked_dry_run", {
            attemptId: held.attemptId,
            reason: "dry_run_checkout_ready",
          });
          return {
            processed,
            blocked: true,
            attemptId: held.attemptId,
            reason: "dry_run_checkout_ready",
          };
        }
        this.dryRunHeldAttemptId = null;
      }
      if (this.store.storageStatus?.().state === "degraded") {
        return { processed, blocked: true, reason: "storage_degraded" };
      }
      if (this.#scopeUnavailable()) {
        return { processed, blocked: true, reason: "account_scope_unavailable" };
      }
      const unresolved = this.store.listAttempts({
        states: [ATTEMPT_STATES.PAYMENT_SUBMITTED, ATTEMPT_STATES.CONFIRMING, ATTEMPT_STATES.UNKNOWN],
        limit: 1,
      })[0];
      if (unresolved) {
        this.log("queue_blocked_unresolved_payment", { attemptId: unresolved.attemptId });
        return {
          processed,
          blocked: true,
          attemptId: unresolved.attemptId,
          reason: "unresolved_payment",
        };
      }
      const attempt = this.store.getNextQueuedAttempt();
      if (!attempt) return { processed, blocked: false };
      if (!this.#isCurrentSearch(attempt.searchId)) {
        processed.push(this.#skipOutOfScopeAttempt(attempt));
        continue;
      }
      if (this.policy.requiresArmed(attempt.mode) && !this.getArmState().armed) {
        this.log("queue_blocked_disarmed", { attemptId: attempt.attemptId });
        return { processed, blocked: true, attemptId: attempt.attemptId };
      }
      const result = await this.#processAttempt(attempt, signal);
      processed.push(result);
      // Keep the visible browser on the page that needs attention. Navigating
      // to another listing could destroy a verification flow or obscure an
      // ambiguous payment that must be reconciled before any further work.
      if (result.result === "dry_run") {
        this.log("queue_blocked_dry_run", {
          attemptId: result.attempt.attemptId,
          reason: result.reason ?? "dry_run_checkout_ready",
        });
        return {
          processed,
          blocked: true,
          attemptId: result.attempt.attemptId,
          reason: result.reason ?? "dry_run_checkout_ready",
        };
      }
      if (result.result === "needs_user_action" || result.result === "unknown") {
        return {
          processed,
          blocked: true,
          attemptId: result.attempt.attemptId,
          reason: result.result,
        };
      }
    }
  }

  async #processAttempt(original, signal) {
    let attempt = this.store.getAttempt(original.attemptId);
    const context = { signal, mode: attempt.mode, attemptId: attempt.attemptId };
    try {
      // An attempt may wait while the agent is disarmed. Re-evaluate the
      // persisted event and item immediately before opening the browser so an
      // item that was fresh when queued can never be purchased after its
      // freshness window has elapsed.
      const event = this.store.getEvent(attempt.eventId);
      const item = this.store.getItem(attempt.itemKey);
      if (!event || !item) throw new PolicyRejection("persisted_item_missing");
      if (!this.#isCurrentSearch(attempt.searchId) || !this.#isCurrentSearch(event.searchId)) {
        return this.#skipOutOfScopeAttempt(attempt);
      }
      this.policy.evaluateItem({ ...event, items: [item] }, item, this.clock());

      const opened = resultObject(await this.executor.openListing(attempt, context), "openListing");
      if (opened.needsUserAction) return this.#pausePreSubmit(attempt, opened);
      const listing = resultObject(await this.executor.inspectListing(attempt, { ...context, opened }), "inspectListing");
      if (listing.needsUserAction) return this.#pausePreSubmit(attempt, listing);
      if (listing.available === false) throw new PolicyRejection("listing_unavailable");
      if (listing.itemId !== undefined && String(listing.itemId) !== String(attempt.itemId)) {
        throw new PolicyRejection("listing_item_mismatch");
      }
      if (listing.priceMinor !== undefined && listing.priceMinor !== attempt.itemPriceMinor) {
        throw new PolicyRejection("listing_price_changed", {
          expected: attempt.itemPriceMinor,
          actual: listing.priceMinor,
        });
      }
      attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.LISTING_CHECKED);

      const checkoutOpened = resultObject(
        await this.executor.openCheckout(attempt, { ...context, listing }),
        "openCheckout",
      );
      if (checkoutOpened.needsUserAction) return this.#pausePreSubmit(attempt, checkoutOpened);
      attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.CHECKOUT_OPENED);

      // Discovery can remove a search while checkout is opening. Keep the
      // same scope guard before the dry-run hold as before any payment action.
      if (!this.#isCurrentSearch(attempt.searchId)) {
        return this.#failOutOfScopeAttempt(attempt);
      }

      // Dry-run is a browser preview: once the exact checkout page is open,
      // leave it visible and stop the serial worker before reading payment
      // details or touching any later listing.
      if (attempt.mode === EXECUTION_MODES.DRY_RUN) {
        attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.DRY_RUN, {
          reason: "dry_run_no_payment_submitted",
        });
        this.store.markReservation(attempt.attemptId, RESERVATION_STATES.RELEASED);
        this.dryRunHeldAttemptId = attempt.attemptId;
        return { attempt, result: "dry_run", reason: "dry_run_checkout_ready" };
      }

      const checkout = resultObject(
        await this.executor.readCheckout(attempt, { ...context, listing, checkoutOpened }),
        "readCheckout",
      );
      if (checkout.needsUserAction) {
        return this.#pausePreSubmit(attempt, checkout);
      }
      const total = this.policy.evaluateFinalTotal(attempt, checkout, this.clock());
      this.store.adjustReservation({
        attemptId: attempt.attemptId,
        amountMinor: total.totalMinor,
        maxDailySpendMinor: this.policy.maxDailySpendMinor,
      });
      attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.TOTAL_VERIFIED, {
        finalTotalMinor: total.totalMinor,
      });

      // Discovery can remove a search while a checkout is open. Re-check the
      // scope immediately before any mode-specific final action; this keeps a
      // stale queued attempt from crossing the payment boundary.
      if (!this.#isCurrentSearch(attempt.searchId)) {
        return this.#failOutOfScopeAttempt(attempt);
      }

      if (attempt.mode === EXECUTION_MODES.HUMAN_FINAL) {
        attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.NEEDS_USER_ACTION, {
          reason: "human_final_required",
        });
        return { attempt, result: "needs_user_action" };
      }
      // Disarm is checked again immediately before crossing the payment
      // boundary; a user may have pressed the stop control while checkout was
      // loading.
      if (!this.getArmState().armed) {
        attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.NEEDS_USER_ACTION, {
          reason: "disarmed_before_payment",
        });
        return { attempt, result: "needs_user_action" };
      }

      if (!this.#isCurrentSearch(attempt.searchId)) {
        return this.#failOutOfScopeAttempt(attempt);
      }

      // Persist this before calling any final payment method. If the process
      // dies during the call, recovery marks it unknown and never retries.
      attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.PAYMENT_SUBMITTED, {
        reason: "final_payment_call_started",
      });
      let payment;
      try {
        payment = resultObject(await this.executor.submitPayment(attempt, {
          ...context, listing, checkout,
        }), "submitPayment");
      } catch (error) {
        return this.#markUnknown(attempt, "payment_call_error", error);
      }
      if (payment.outcome === PAYMENT_OUTCOMES.FAILED_BEFORE_SUBMIT) {
        attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.FAILED, {
          reason: resultReason(payment.reason, "payment_failed_before_submit"),
        });
        this.store.markReservation(attempt.attemptId, RESERVATION_STATES.RELEASED);
        return { attempt, result: "failed" };
      }
      if (payment.outcome === PAYMENT_OUTCOMES.NEEDS_USER_ACTION) {
        attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.NEEDS_USER_ACTION, {
          reason: resultReason(payment.reason, "payment_verification_required"),
        });
        this.store.markReservation(attempt.attemptId, RESERVATION_STATES.HELD);
        return { attempt, result: "needs_user_action" };
      }
      if (payment.outcome !== PAYMENT_OUTCOMES.SUBMITTED) {
        return this.#markUnknown(attempt, resultReason(payment.reason, "payment_outcome_unknown"), payment);
      }
      attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.CONFIRMING, {
        orderId: payment.orderId ?? null,
      });
      return this.#reconcile(attempt, { ...context, listing, checkout, payment });
    } catch (error) {
      attempt = this.store.getAttempt(original.attemptId);
      if (!attempt) throw error;
      if ([ATTEMPT_STATES.PAYMENT_SUBMITTED, ATTEMPT_STATES.CONFIRMING].includes(attempt.state)) {
        return this.#markUnknown(attempt, "error_after_payment_boundary", error);
      }
      if (![ATTEMPT_STATES.FAILED, ATTEMPT_STATES.DRY_RUN, ATTEMPT_STATES.SKIPPED, ATTEMPT_STATES.UNKNOWN].includes(attempt.state)) {
        attempt = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.FAILED, {
          reason: asErrorReason(error),
        });
        this.store.markReservation(attempt.attemptId, RESERVATION_STATES.RELEASED);
      }
      this.log("attempt_failed", { attemptId: attempt.attemptId, reason: asErrorReason(error) });
      return { attempt, result: "failed", error: asErrorReason(error) };
    }
  }

  async recordHumanFinal(attemptId, payment) {
    let attempt = this.store.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
    if (attempt.mode !== EXECUTION_MODES.HUMAN_FINAL || attempt.state !== ATTEMPT_STATES.NEEDS_USER_ACTION || attempt.reason !== "human_final_required") {
      throw new Error("Attempt is not waiting for a human final payment action");
    }
    if (!this.#isCurrentSearch(attempt.searchId)) {
      throw new Error("Attempt search is no longer in the current account scope");
    }
    if (payment?.outcome === PAYMENT_OUTCOMES.FAILED_BEFORE_SUBMIT) {
      attempt = this.store.transitionAttempt(attemptId, ATTEMPT_STATES.FAILED, {
        reason: resultReason(payment.reason, "human_payment_failed"),
      });
      this.store.markReservation(attemptId, RESERVATION_STATES.RELEASED);
      return { attempt, result: "failed" };
    }
    if (payment?.outcome !== PAYMENT_OUTCOMES.SUBMITTED) {
      return this.#markUnknown(attempt, payment?.reason ?? "human_payment_outcome_unknown", payment);
    }
    attempt = this.store.transitionAttempt(attemptId, ATTEMPT_STATES.PAYMENT_SUBMITTED, {
      reason: "human_payment_submitted",
      orderId: payment.orderId ?? null,
    });
    attempt = this.store.transitionAttempt(attemptId, ATTEMPT_STATES.CONFIRMING);
    return this.#reconcile(attempt, { attemptId, mode: attempt.mode });
  }

  resumePreSubmit(attemptId) {
    const current = this.store.getAttempt(attemptId);
    if (current && !this.#isCurrentSearch(current.searchId)) {
      throw new Error("Attempt search is no longer in the current account scope");
    }
    const attempt = this.store.requeuePreSubmitAttempt(attemptId);
    this.log("pre_submit_resumed", { attemptId });
    return attempt;
  }

  async reconcileAttempt(attemptId) {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
    if (![ATTEMPT_STATES.PAYMENT_SUBMITTED, ATTEMPT_STATES.CONFIRMING, ATTEMPT_STATES.NEEDS_USER_ACTION, ATTEMPT_STATES.UNKNOWN].includes(attempt.state)) {
      throw new Error(`Attempt cannot be reconciled from state ${attempt.state}`);
    }
    if (attempt.state === ATTEMPT_STATES.NEEDS_USER_ACTION && attempt.reason === "human_final_required") {
      throw new Error("Human final action has not been recorded");
    }
    if (attempt.state === ATTEMPT_STATES.NEEDS_USER_ACTION && String(attempt.reason ?? "").startsWith("pre_submit_")) {
      throw new Error("Attempt is waiting for a pre-submit user action and cannot be reconciled yet");
    }
    let current = attempt;
    if (current.state === ATTEMPT_STATES.PAYMENT_SUBMITTED || current.state === ATTEMPT_STATES.NEEDS_USER_ACTION) {
      current = this.store.transitionAttempt(attemptId, ATTEMPT_STATES.CONFIRMING, { reason: "reconciliation_started" });
    }
    return this.#reconcile(current, { attemptId, mode: current.mode });
  }

  async #reconcile(attempt, context) {
    let outcome;
    try {
      outcome = resultObject(await this.executor.reconcileOrder(attempt, context), "reconcileOrder");
    } catch (error) {
      return this.#markUnknown(attempt, "reconciliation_error", error);
    }
    if (outcome.outcome === RECONCILE_OUTCOMES.SUCCEEDED) {
      const succeeded = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.SUCCEEDED, {
        reason: resultReason(outcome.reason, "order_confirmed"),
        orderId: outcome.orderId ?? attempt.orderId,
      });
      this.store.markReservation(attempt.attemptId, RESERVATION_STATES.COMMITTED);
      return { attempt: succeeded, result: "succeeded" };
    }
    if (outcome.outcome === RECONCILE_OUTCOMES.FAILED) {
      const failed = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.FAILED, {
        reason: resultReason(outcome.reason, "order_failed"),
      });
      this.store.markReservation(attempt.attemptId, RESERVATION_STATES.RELEASED);
      return { attempt: failed, result: "failed" };
    }
    if (outcome.outcome === RECONCILE_OUTCOMES.NEEDS_USER_ACTION) {
      const waiting = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.NEEDS_USER_ACTION, {
        reason: resultReason(outcome.reason, "order_needs_user_action"),
      });
      this.store.markReservation(attempt.attemptId, RESERVATION_STATES.HELD);
      return { attempt: waiting, result: "needs_user_action" };
    }
    return this.#markUnknown(attempt, outcome.reason ?? "reconciliation_unknown", outcome);
  }

  #pausePreSubmit(attempt, browserResult) {
    const rawReason = resultReason(
      browserResult?.reason,
      resultReason(browserResult?.status, "verification_required"),
    ).replace(/^pre_submit_/, "");
    const waiting = this.store.transitionAttempt(attempt.attemptId, ATTEMPT_STATES.NEEDS_USER_ACTION, {
      reason: `pre_submit_${rawReason}`,
    });
    this.log("attempt_needs_user_action", {
      attemptId: attempt.attemptId,
      reason: waiting.reason,
    });
    return { attempt: waiting, result: "needs_user_action" };
  }

  #markUnknown(attempt, reason, metadata = null) {
    const current = this.store.getAttempt(attempt.attemptId);
    if (current.state === ATTEMPT_STATES.UNKNOWN) return { attempt: current, result: "unknown" };
    const safeReason = resultReason(reason, "payment_outcome_unknown");
    const unknown = this.store.transitionAttempt(current.attemptId, ATTEMPT_STATES.UNKNOWN, {
      reason: safeReason,
      metadata: safeMetadata(metadata),
    });
    this.store.markReservation(current.attemptId, RESERVATION_STATES.HELD);
    this.log("attempt_unknown", { attemptId: current.attemptId, reason: safeReason });
    return { attempt: unknown, result: "unknown" };
  }

  recoverAfterCrash() {
    const result = this.store.recoverAfterCrash();
    this.log("recovery_complete", result);
    return result;
  }

  dailyUsage(now = this.clock(), currency = null) {
    const dayKey = utcDayKey(now);
    const selectedCurrency = currency ?? [...this.policy.currencyAllowlist][0];
    return this.store.getDailyUsage(dayKey, selectedCurrency);
  }
}
