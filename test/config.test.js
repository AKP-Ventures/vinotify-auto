import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig, persistPurchaseLimits, publicConfig } from "../src/config.js";

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "local-buy-config-"));
  const filename = join(directory, "config.json");
  const value = {
    vinotify: { baseUrl: "https://vinotify.me", bearerToken: "vni_secret", searchIds: [42] },
    browser: { userDataDir: "profile" },
    purchase: {
      mode: "dry_run",
      searchAllowlist: [42],
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
    },
    ...overrides,
  };
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  await chmod(filename, 0o600);
  return { directory, filename };
}

test("loads a safe config and never exposes its bearer token", async () => {
  const { directory, filename } = await fixture();
  try {
    const config = await loadConfig(filename);
    assert.equal(config.purchase.mode, "dry_run");
    assert.equal(config.vinotify.maxConcurrentFeeds, 8);
    assert.deepEqual(config.purchase.searchAllowlist, ["42"]);
    assert.equal(config.storage.databasePath, join(directory, "data/agent.sqlite3"));
    assert.equal(config.browser.userDataDir, join(directory, "profile"));
    const visible = publicConfig(config);
    assert.equal(JSON.stringify(visible).includes("vni_secret"), false);
    assert.deepEqual(visible.purchase.searchAllowlist, ["42"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("search selection is explicit even though account discovery remains dynamic", async () => {
  const { directory, filename } = await fixture({
    vinotify: { baseUrl: "https://vinotify.me", bearerToken: "vni_secret" },
  });
  try {
    const config = await loadConfig(filename);
    assert.deepEqual(config.vinotify.searchIds, []);
    assert.equal(config.vinotify.discoveryRefreshSeconds, 60);
    const visible = publicConfig(config);
    assert.equal(visible.vinotify.searchScope, "selected purchase searches");
    assert.equal("searchIds" in visible.vinotify, false);
    assert.deepEqual(visible.purchase.searchAllowlist, ["42"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires a non-empty allowlist of positive search IDs", async () => {
  for (const searchAllowlist of [undefined, [], [0], [-1], [1.5], [true], ["not-an-id"]]) {
    const { directory, filename } = await fixture({
      purchase: {
        mode: "dry_run",
        ...(searchAllowlist === undefined ? {} : { searchAllowlist }),
        maxItemPriceMinor: 2500,
        maxCheckoutTotalMinor: 4000,
        maxDailySpendMinor: 10000,
        maxDailyCount: 2,
      },
    });
    try {
      await assert.rejects(() => loadConfig(filename), /purchase\.searchAllowlist/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("normalizes numeric search IDs to unique, sorted strings", async () => {
  const { directory, filename } = await fixture({
    purchase: {
      mode: "dry_run",
      searchAllowlist: ["042", 42, "7"],
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
    },
  });
  try {
    const config = await loadConfig(filename);
    assert.deepEqual(config.purchase.searchAllowlist, ["7", "42"]);
    assert.deepEqual(publicConfig(config).purchase.searchAllowlist, ["7", "42"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public build rejects auto-submit even when explicitly enabled", async () => {
  const { directory, filename } = await fixture({
    vinotify: { baseUrl: "https://vinotify.me", bearerToken: "vni_secret", searchIds: [42] },
    browser: { userDataDir: "profile" },
    purchase: {
      mode: "auto_submit",
      enableAutoSubmit: true,
      searchAllowlist: [42],
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
    },
  });
  try {
    await assert.rejects(() => loadConfig(filename), /auto_submit.*public build/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public build rejects the auto-submit enable flag in every mode", async () => {
  const { directory, filename } = await fixture({
    purchase: {
      mode: "dry_run",
      enableAutoSubmit: true,
      searchAllowlist: [42],
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
    },
  });
  try {
    await assert.rejects(() => loadConfig(filename), /enableAutoSubmit.*unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pins the feed origin to Vinotify production", async () => {
  const { directory, filename } = await fixture({
    vinotify: { baseUrl: "https://vinotify.me/api", bearerToken: "vni_secret", searchIds: [42] },
    browser: { userDataDir: "profile" },
    purchase: {
      searchAllowlist: [42],
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
    },
  });
  try {
    await assert.rejects(() => loadConfig(filename), /exactly https:\/\/vinotify\.me/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("caps concurrent feed polling at twelve", async () => {
  const accepted = await fixture({
    vinotify: { baseUrl: "https://vinotify.me", bearerToken: "vni_secret", maxConcurrentFeeds: 12 },
  });
  try {
    assert.equal((await loadConfig(accepted.filename)).vinotify.maxConcurrentFeeds, 12);
  } finally {
    await rm(accepted.directory, { recursive: true, force: true });
  }

  const rejected = await fixture({
    vinotify: { baseUrl: "https://vinotify.me", bearerToken: "vni_secret", maxConcurrentFeeds: 13 },
  });
  try {
    await assert.rejects(() => loadConfig(rejected.filename), /maxConcurrentFeeds.*between 1 and 12/);
  } finally {
    await rm(rejected.directory, { recursive: true, force: true });
  }
});

test("fails closed when a token-bearing config is group-readable", async () => {
  const { directory, filename } = await fixture();
  try {
    await chmod(filename, 0o640);
    await assert.rejects(() => loadConfig(filename), /readable by group or other/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment-only token does not require a secret-bearing config permission", async () => {
  const { directory, filename } = await fixture({
    vinotify: { baseUrl: "https://vinotify.me" },
  });
  const previous = process.env.LOCAL_BUY_VINOTIFY_TOKEN;
  process.env.LOCAL_BUY_VINOTIFY_TOKEN = "env-secret";
  try {
    await chmod(filename, 0o644);
    const config = await loadConfig(filename);
    assert.equal(config.vinotify.bearerToken, "env-secret");
  } finally {
    if (previous === undefined) delete process.env.LOCAL_BUY_VINOTIFY_TOKEN;
    else process.env.LOCAL_BUY_VINOTIFY_TOKEN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists only purchase limits atomically and preserves config metadata", async () => {
  const { directory, filename } = await fixture({
    vinotify: {
      baseUrl: "https://vinotify.me",
      bearerToken: "vni_secret",
      searchIds: [42],
      unrelatedSecret: "keep-me",
    },
    purchase: {
      mode: "human_final",
      enableAutoSubmit: false,
      marketAllowlist: ["UK"],
      currencyAllowlist: ["GBP"],
      searchAllowlist: [42],
      maxEventAgeSeconds: 120,
      maxItemPriceMinor: 2500,
      maxCheckoutTotalMinor: 4000,
      maxDailySpendMinor: 10000,
      maxDailyCount: 2,
      armDurationSeconds: 900,
      unrelatedPurchaseSetting: "keep-me-too",
    },
  });
  try {
    const before = JSON.parse(await readFile(filename, "utf8"));
    await chmod(filename, 0o640);
    const beforeMode = (await stat(filename)).mode & 0o7777;
    const limits = {
      maxItemPriceMinor: 3000,
      maxCheckoutTotalMinor: 5000,
      maxDailySpendMinor: 15000,
      maxDailyCount: 3,
      armDurationSeconds: 1200,
    };

    await persistPurchaseLimits(filename, limits);

    const after = JSON.parse(await readFile(filename, "utf8"));
    assert.deepEqual(after.vinotify, before.vinotify);
    assert.deepEqual(after.browser, before.browser);
    assert.deepEqual(after.purchase, { ...before.purchase, ...limits });
    assert.equal((await stat(filename)).mode & 0o7777, beforeMode);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
