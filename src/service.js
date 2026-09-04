import { ATTEMPT_STATES, EXECUTION_MODES } from "./core/types.js";
import { PAYMENT_OUTCOMES } from "./core/browser-executor.js";
import {
  normalizePurchaseLimits,
  persistPurchaseLimits as persistPurchaseLimitsToFile,
  publicConfig,
} from "./config.js";

export class AgentService {
  constructor({
    config,
    queue,
    store,
    runtime = null,
    runtimeStatus = () => ({}),
    persistPurchaseLimits = persistPurchaseLimitsToFile,
  } = {}) {
    if (!config || !queue || !store) throw new TypeError("config, queue, and store are required");
    this.config = config;
    this.queue = queue;
    this.store = store;
    this.runtime = runtime;
    this.runtimeStatus = runtimeStatus;
    if (typeof persistPurchaseLimits !== "function") {
      throw new TypeError("persistPurchaseLimits must be a function");
    }
    this.persistPurchaseLimits = persistPurchaseLimits;
    this.purchaseLimitsUpdate = Promise.resolve();
    this.purchaseLimitsSaving = false;
  }

  async status() {
    const attempts = this.store.listAttempts({ limit: 100 });
    const byState = {};
    for (const attempt of attempts) byState[attempt.state] = (byState[attempt.state] ?? 0) + 1;
    return {
      mode: this.queue.getMode(),
      ...this.queue.getArmState(),
      attemptCounts: byState,
      ...this.runtimeStatus(),
    };
  }

  async settings() {
    return publicConfig(this.config);
  }

  async updatePurchaseLimits(value) {
    const limits = normalizePurchaseLimits(value);
    const update = async () => {
      if (!this.config.source) throw new Error("Config source is unavailable");
      if (!this.config.purchase || !this.queue.policy) {
        throw new Error("Purchase policy is unavailable");
      }
      if (typeof this.queue.disarm !== "function") throw new Error("Queue disarm is unavailable");

      this.purchaseLimitsSaving = true;
      let disarmed = false;
      try {
        // Any attempt to change the limits must first remove the current arm.
        // If persistence fails, this remains the only live-state change.
        await this.queue.disarm("purchase_limits_changed");
        disarmed = true;
        await this.persistPurchaseLimits(this.config.source, limits);

        // Do not mutate either object until the on-disk replacement has
        // succeeded; live policy cannot get ahead of durable configuration.
        Object.assign(this.config.purchase, limits);
        Object.assign(this.queue.policy, limits);
        return this.settings();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Could not save purchase limits");
        if (disarmed) failure.code = "LIMITS_SAVE_FAILED_DISARMED";
        throw failure;
      } finally {
        this.purchaseLimitsSaving = false;
      }
    };

    // Multiple local tabs can submit together. Serialize updates so the final
    // in-memory policy always matches the final atomic file replacement.
    const pending = this.purchaseLimitsUpdate.then(update, update);
    this.purchaseLimitsUpdate = pending.catch(() => {});
    return pending;
  }

  async mode() {
    return { mode: this.queue.getMode() };
  }

  async setMode({ mode }) {
    if (this.purchaseLimitsSaving) {
      const error = new Error("Purchase limits are being saved");
      error.code = "LIMITS_UPDATE_IN_PROGRESS";
      throw error;
    }
    if (mode === EXECUTION_MODES.AUTO_SUBMIT && !this.config.purchase.enableAutoSubmit) {
      const error = new Error("Auto-submit is disabled in config");
      error.code = "AUTO_SUBMIT_DISABLED";
      throw error;
    }
    this.queue.disarm("mode_changed");
    return { mode: this.queue.setMode(mode), ...this.queue.getArmState() };
  }

  async arm({ ttlSeconds } = {}) {
    if (this.purchaseLimitsSaving) {
      const error = new Error("Purchase limits are being saved");
      error.code = "LIMITS_UPDATE_IN_PROGRESS";
      throw error;
    }
    const mode = this.queue.getMode();
    if (mode === EXECUTION_MODES.DRY_RUN) {
      const error = new Error("Dry-run does not need to be armed");
      error.code = "DRY_RUN_ARM_FORBIDDEN";
      throw error;
    }
    if (mode === EXECUTION_MODES.AUTO_SUBMIT && !this.config.purchase.enableAutoSubmit) {
      const error = new Error("Auto-submit is disabled in config");
      error.code = "AUTO_SUBMIT_DISABLED";
      throw error;
    }
    const duration = ttlSeconds ?? this.config.purchase.armDurationSeconds;
    const result = this.queue.arm({ durationMs: duration * 1000 });
    void this.queue.drain().catch(() => {});
    return result;
  }

  async disarm() {
    return this.queue.disarm("user_disarmed");
  }

  async recentAttempts({ limit = 20 } = {}) {
    return {
      attempts: this.store.listRecentAttempts(limit),
    };
  }

  async health() {
    const runtime = this.runtimeStatus();
    return {
      ok: !runtime.degraded && !runtime.fatal,
      database: "ok",
      browser: runtime.browser ?? "not_started",
      feeds: runtime.feeds ?? {},
    };
  }

  async resumeAttempt({ attemptId }) {
    const attempt = this.queue.resumePreSubmit(attemptId);
    const drain = await this.queue.drain();
    return { attempt: this.store.getAttempt(attempt.attemptId), drain };
  }

  async recordHumanSubmitted({ attemptId }) {
    const result = await this.queue.recordHumanFinal(attemptId, {
      outcome: PAYMENT_OUTCOMES.SUBMITTED,
      reason: "user_confirmed_human_submission",
    });
    if (["succeeded", "failed"].includes(result.result)) void this.queue.drain().catch(() => {});
    return result;
  }

  async reconcileAttempt({ attemptId }) {
    const result = await this.queue.reconcileAttempt(attemptId);
    if (["succeeded", "failed"].includes(result.result)) void this.queue.drain().catch(() => {});
    return result;
  }

  async resetFeedCursor({ searchId }) {
    if (!this.runtime || typeof this.runtime.resetCursor !== "function") {
      throw new Error("Feed runtime is unavailable");
    }
    this.queue.disarm("feed_cursor_reset");
    return this.runtime.resetCursor(searchId);
  }
}

export function initializeExecutionMode({ config, queue, store }) {
  const saved = store.getSetting("execution_mode", null);
  if (saved === null) return queue.setMode(config.purchase.mode);
  if (saved === EXECUTION_MODES.AUTO_SUBMIT && !config.purchase.enableAutoSubmit) {
    return queue.setMode(EXECUTION_MODES.DRY_RUN);
  }
  queue.policy.validateMode(saved);
  return saved;
}

export const ACTIONABLE_STATES = Object.freeze([
  ATTEMPT_STATES.NEEDS_USER_ACTION,
  ATTEMPT_STATES.PAYMENT_SUBMITTED,
  ATTEMPT_STATES.CONFIRMING,
  ATTEMPT_STATES.UNKNOWN,
]);
