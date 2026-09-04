import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { PurchasePolicy } from "../src/core/policy.js";
import { AgentService } from "../src/service.js";

const LIMITS = Object.freeze({
  maxItemPriceMinor: 3000,
  maxCheckoutTotalMinor: 5000,
  maxDailySpendMinor: 15000,
  maxDailyCount: 3,
  armDurationSeconds: 1200,
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "local-buy-service-"));
  const filename = join(directory, "config.json");
  await writeFile(filename, JSON.stringify({
    vinotify: { baseUrl: "https://vinotify.me", bearerToken: "vni_secret" },
    browser: { userDataDir: "profile" },
    purchase: {
      mode: "dry_run",
      searchAllowlist: [42],
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
      armDurationSeconds: 900,
    },
  }), { mode: 0o600 });
  const config = await loadConfig(filename);
  const policy = new PurchasePolicy(config.purchase);
  const calls = [];
  const queue = {
    policy,
    async disarm(reason) {
      calls.push(["disarm", reason]);
      return { armed: false };
    },
  };
  const store = {};
  return { directory, filename, config, policy, queue, store, calls };
}

test("updatePurchaseLimits disarms, persists, and updates live settings and policy", async () => {
  const state = await fixture();
  try {
    const service = new AgentService(state);
    const result = await service.updatePurchaseLimits(LIMITS);

    assert.deepEqual(state.calls, [["disarm", "purchase_limits_changed"]]);
    assert.deepEqual(
      Object.fromEntries(Object.keys(LIMITS).map((key) => [key, state.config.purchase[key]])),
      LIMITS,
    );
    assert.deepEqual(
      Object.fromEntries(Object.keys(LIMITS).map((key) => [key, state.policy[key]])),
      LIMITS,
    );
    assert.deepEqual(result.purchase, service.config.purchase);
    const persisted = JSON.parse(await readFile(state.filename, "utf8"));
    assert.deepEqual(
      Object.fromEntries(Object.keys(LIMITS).map((key) => [key, persisted.purchase[key]])),
      LIMITS,
    );
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("a failed save leaves config and policy unchanged while disarmed", async () => {
  const state = await fixture();
  try {
    const beforeConfig = structuredClone(state.config.purchase);
    const beforePolicy = Object.fromEntries([
      "maxItemPriceMinor",
      "maxCheckoutTotalMinor",
      "maxDailySpendMinor",
      "maxDailyCount",
      "armDurationSeconds",
    ].map((key) => [key, state.policy[key]]));
    const service = new AgentService({
      ...state,
      persistPurchaseLimits: async () => {
        throw new Error("disk full");
      },
    });

    await assert.rejects(
      () => service.updatePurchaseLimits(LIMITS),
      (error) => error.message === "disk full" && error.code === "LIMITS_SAVE_FAILED_DISARMED",
    );
    assert.deepEqual(state.config.purchase, beforeConfig);
    assert.deepEqual(
      Object.fromEntries([
        "maxItemPriceMinor",
        "maxCheckoutTotalMinor",
        "maxDailySpendMinor",
        "maxDailyCount",
        "armDurationSeconds",
      ].map((key) => [key, state.policy[key]])),
      beforePolicy,
    );
    assert.deepEqual(state.calls, [["disarm", "purchase_limits_changed"]]);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("updatePurchaseLimits rejects incomplete and unsafe values before disarming", async () => {
  const state = await fixture();
  try {
    const service = new AgentService({
      ...state,
      persistPurchaseLimits: async () => {
        throw new Error("must not save");
      },
    });
    for (const invalid of [
      { ...LIMITS, maxItemPriceMinor: 0 },
      { ...LIMITS, maxDailyCount: 101 },
      { ...LIMITS, armDurationSeconds: 3601 },
      { ...LIMITS, maxCheckoutTotalMinor: 2999 },
      { ...LIMITS, maxDailySpendMinor: 4999 },
      { ...LIMITS, maxDailyCount: undefined },
      { ...LIMITS, extra: 1 },
    ]) {
      await assert.rejects(() => service.updatePurchaseLimits(invalid), TypeError);
    }
    assert.deepEqual(state.calls, []);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("concurrent limit saves are serialized so disk and live policy agree", async () => {
  const state = await fixture();
  try {
    const persisted = [];
    const service = new AgentService({
      ...state,
      persistPurchaseLimits: async (_filename, limits) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, limits.maxDailyCount === 3 ? 10 : 0));
        persisted.push(structuredClone(limits));
      },
    });
    const later = { ...LIMITS, maxDailyCount: 4 };

    await Promise.all([
      service.updatePurchaseLimits(LIMITS),
      service.updatePurchaseLimits(later),
    ]);

    assert.deepEqual(persisted, [LIMITS, later]);
    assert.equal(state.config.purchase.maxDailyCount, 4);
    assert.equal(state.policy.maxDailyCount, 4);
    assert.deepEqual(state.calls, [
      ["disarm", "purchase_limits_changed"],
      ["disarm", "purchase_limits_changed"],
    ]);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("arming and mode changes are rejected while limits are being persisted", async () => {
  const state = await fixture();
  let releasePersistence;
  let persistenceStarted;
  const started = new Promise((resolvePromise) => { persistenceStarted = resolvePromise; });
  const blocked = new Promise((resolvePromise) => { releasePersistence = resolvePromise; });
  try {
    const service = new AgentService({
      ...state,
      persistPurchaseLimits: async () => {
        persistenceStarted();
        await blocked;
      },
    });
    const saving = service.updatePurchaseLimits(LIMITS);
    await started;

    await assert.rejects(
      () => service.arm(),
      { code: "LIMITS_UPDATE_IN_PROGRESS" },
    );
    await assert.rejects(
      () => service.setMode({ mode: "human_final" }),
      { code: "LIMITS_UPDATE_IN_PROGRESS" },
    );

    releasePersistence();
    await saving;
    assert.deepEqual(state.calls, [["disarm", "purchase_limits_changed"]]);
  } finally {
    releasePersistence?.();
    await rm(state.directory, { recursive: true, force: true });
  }
});
