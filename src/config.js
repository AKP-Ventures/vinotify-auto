import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { EXECUTION_MODES } from "./core/types.js";

const MODE_ALIASES = Object.freeze({
  "dry-run": EXECUTION_MODES.DRY_RUN,
  "human-final": EXECUTION_MODES.HUMAN_FINAL,
  "auto-submit": EXECUTION_MODES.AUTO_SUBMIT,
});

const PURCHASE_LIMIT_FIELDS = Object.freeze([
  "maxItemPriceMinor",
  "maxCheckoutTotalMinor",
  "maxDailySpendMinor",
  "maxDailyCount",
  "armDurationSeconds",
]);

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function positiveInteger(value, field, { max = Number.MAX_SAFE_INTEGER, allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > max) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${max}`);
  }
  return value;
}

/**
 * Validate the complete set of limits accepted by the live control surface.
 * Keeping this separate from loadConfig means a live update cannot silently
 * fall back to startup defaults for a missing field.
 */
export function normalizePurchaseLimits(value) {
  object(value, "purchase limits");
  const fields = Object.keys(value);
  if (
    fields.length !== PURCHASE_LIMIT_FIELDS.length ||
    fields.some((field) => !PURCHASE_LIMIT_FIELDS.includes(field))
  ) {
    throw new TypeError("purchase limits must contain only the supported fields");
  }
  for (const field of PURCHASE_LIMIT_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${field} is required`);
  }
  const limits = {
    maxItemPriceMinor: positiveInteger(value.maxItemPriceMinor, "maxItemPriceMinor"),
    maxCheckoutTotalMinor: positiveInteger(value.maxCheckoutTotalMinor, "maxCheckoutTotalMinor"),
    maxDailySpendMinor: positiveInteger(value.maxDailySpendMinor, "maxDailySpendMinor"),
    maxDailyCount: positiveInteger(value.maxDailyCount, "maxDailyCount", { max: 100 }),
    armDurationSeconds: positiveInteger(value.armDurationSeconds, "armDurationSeconds", { max: 3600 }),
  };
  if (limits.maxCheckoutTotalMinor < limits.maxItemPriceMinor) {
    throw new TypeError("maxCheckoutTotalMinor cannot be lower than maxItemPriceMinor");
  }
  if (limits.maxDailySpendMinor < limits.maxCheckoutTotalMinor) {
    throw new TypeError("maxDailySpendMinor cannot be lower than maxCheckoutTotalMinor");
  }
  return limits;
}

async function removeTemporaryFile(filename) {
  try {
    await unlink(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * Replace only the purchase-limit fields in a config file. The temporary file
 * is created beside the source and renamed into place, so a failed write can
 * never leave a partially-written config. Its mode is copied before the
 * rename because rename adopts the temporary file's metadata.
 */
export async function persistPurchaseLimits(filename, value) {
  const limits = normalizePurchaseLimits(value);
  if (!filename) throw new TypeError("A config file is required");
  const absoluteFilename = resolve(filename);
  const details = await stat(absoluteFilename);
  if (!details.isFile()) throw new Error("Config source must be a regular file");

  let raw;
  try {
    raw = JSON.parse(await readFile(absoluteFilename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read config ${absoluteFilename}: ${error.message}`, { cause: error });
  }
  object(raw, "config");
  const purchase = object(raw.purchase, "purchase");
  const updated = {
    ...raw,
    purchase: { ...purchase, ...limits },
  };
  const serialized = `${JSON.stringify(updated, null, 2)}\n`;
  const temporaryFilename = `${absoluteFilename}.${process.pid}.${randomUUID()}.tmp`;
  const mode = details.mode & 0o7777;
  let handle = null;
  try {
    handle = await open(temporaryFilename, "wx", mode);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryFilename, mode);
    await rename(temporaryFilename, absoluteFilename);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the write error */ }
    }
    try { await removeTemporaryFile(temporaryFilename); } catch { /* best effort cleanup */ }
    throw error;
  }
  return limits;
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  const normalized = [...new Set(value.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) throw new TypeError(`${field} must contain a value`);
  return normalized;
}

function searchAllowlist(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array of positive search IDs`);
  }
  const normalized = value.map((entry) => {
    const candidate = typeof entry === "string" ? entry.trim() : entry;
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
      const number = Number(candidate);
      if (Number.isSafeInteger(number) && number > 0) return String(number);
    }
    if (Number.isSafeInteger(candidate) && candidate > 0) return String(candidate);
    throw new TypeError(`${field}[] must contain only positive integer search IDs`);
  });
  return [...new Set(normalized)].sort((left, right) => Number(left) - Number(right));
}

function optionalSearchIds(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return [...new Set(value.map((entry) => positiveInteger(entry, `${field}[]`)))];
}

function absoluteFrom(baseDirectory, value, fallback) {
  const selected = value || fallback;
  return isAbsolute(selected) ? resolve(selected) : resolve(baseDirectory, selected);
}

function normalizedMode(value = EXECUTION_MODES.DRY_RUN) {
  const mode = MODE_ALIASES[value] ?? value;
  if (!Object.values(EXECUTION_MODES).includes(mode)) {
    throw new TypeError("purchase.mode must be dry_run or human_final in the public build");
  }
  if (mode === EXECUTION_MODES.AUTO_SUBMIT) {
    throw new TypeError("purchase.mode=auto_submit is unavailable in the public build; use dry_run or human_final");
  }
  return mode;
}

function httpsBaseUrl(value) {
  if (value !== "https://vinotify.me" && value !== "https://vinotify.me/") {
    throw new TypeError("vinotify.baseUrl must be exactly https://vinotify.me");
  }
  const url = new URL(value);
  if (url.toString() !== "https://vinotify.me/" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash || url.port) {
    throw new TypeError("vinotify.baseUrl must be exactly https://vinotify.me");
  }
  return "https://vinotify.me";
}

async function assertTokenConfigPermissions(filename, containsToken) {
  // A token supplied only through the environment is intentionally not a
  // reason to trust the config file: it contains no bearer secret. On POSIX,
  // a file that does contain a token must be owner-only. Windows ACLs are not
  // portable to verify here, so require the safer environment-token path.
  if (!containsToken) return [];
  if (process.platform === "win32") {
    throw new Error("Config files containing bearerToken are unsupported on Windows; use LOCAL_BUY_VINOTIFY_TOKEN");
  }
  const details = await stat(filename);
  if ((details.mode & 0o077) !== 0) {
    throw new Error("Config contains a bearer token but is readable by group or other users; chmod 600 and retry");
  }
  return [];
}

export async function loadConfig(filename) {
  if (!filename) throw new TypeError("A config file is required (use --config <path>)");
  const absoluteFilename = resolve(filename);
  let raw;
  try {
    raw = JSON.parse(await readFile(absoluteFilename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read config ${absoluteFilename}: ${error.message}`);
  }

  object(raw, "config");
  const vinotify = object(raw.vinotify, "vinotify");
  const browser = object(raw.browser, "browser");
  const purchase = object(raw.purchase, "purchase");
  const ui = raw.ui === undefined ? {} : object(raw.ui, "ui");
  const storage = raw.storage === undefined ? {} : object(raw.storage, "storage");
  const baseDirectory = dirname(absoluteFilename);
  // Search discovery still refreshes account membership, but purchases are
  // always restricted to the explicit local selection below.
  const searchIds = optionalSearchIds(vinotify.searchIds, "vinotify.searchIds");

  const bearerToken = String(
    process.env.LOCAL_BUY_VINOTIFY_TOKEN || vinotify.bearerToken || "",
  ).trim();
  if (!bearerToken) {
    throw new TypeError("Set LOCAL_BUY_VINOTIFY_TOKEN or vinotify.bearerToken");
  }

  const mode = normalizedMode(purchase.mode);
  const enableAutoSubmit = purchase.enableAutoSubmit === true;
  if (enableAutoSubmit) {
    throw new TypeError("purchase.enableAutoSubmit is unavailable in the public build; keep it false");
  }

  const config = {
    source: absoluteFilename,
    warnings: await assertTokenConfigPermissions(absoluteFilename, Boolean(vinotify.bearerToken)),
    vinotify: {
      baseUrl: httpsBaseUrl(vinotify.baseUrl ?? "https://vinotify.me"),
      bearerToken,
      searchIds,
      longPollSeconds: positiveInteger(vinotify.longPollSeconds ?? 25, "vinotify.longPollSeconds", { max: 30, allowZero: true }),
      requestTimeoutMs: positiveInteger(vinotify.requestTimeoutMs ?? 35_000, "vinotify.requestTimeoutMs", { max: 120_000 }),
      maxConcurrentFeeds: positiveInteger(
        vinotify.maxConcurrentFeeds ?? 8,
        "vinotify.maxConcurrentFeeds",
        { max: 12 },
      ),
      discoveryRefreshSeconds: positiveInteger(
        vinotify.discoveryRefreshSeconds ?? 60,
        "vinotify.discoveryRefreshSeconds",
        { max: 3_600 },
      ),
    },
    browser: {
      userDataDir: absoluteFrom(baseDirectory, browser.userDataDir, "profile"),
      executablePath: browser.executablePath || undefined,
    },
    storage: {
      databasePath: absoluteFrom(baseDirectory, storage.databasePath, "data/agent.sqlite3"),
      attemptRetentionDays: positiveInteger(storage.attemptRetentionDays ?? 30, "storage.attemptRetentionDays", { max: 3_650 }),
      logRetentionDays: positiveInteger(storage.logRetentionDays ?? 14, "storage.logRetentionDays", { max: 3_650 }),
      maxLogRows: positiveInteger(storage.maxLogRows ?? 10_000, "storage.maxLogRows", { max: 1_000_000 }),
      maxDatabaseBytes: storage.maxDatabaseBytes === undefined || storage.maxDatabaseBytes === null
        ? 512 * 1024 * 1024
        : positiveInteger(storage.maxDatabaseBytes, "storage.maxDatabaseBytes", { max: 10 * 1024 * 1024 * 1024 }),
      cleanupBatchSize: positiveInteger(storage.cleanupBatchSize ?? 250, "storage.cleanupBatchSize", { max: 10_000 }),
      cleanupIntervalSeconds: positiveInteger(storage.cleanupIntervalSeconds ?? 300, "storage.cleanupIntervalSeconds", { max: 86_400 }),
    },
    ui: {
      host: "127.0.0.1",
      port: positiveInteger(ui.port ?? 43121, "ui.port", { max: 65_535, allowZero: true }),
    },
    purchase: {
      mode,
      enableAutoSubmit,
      marketAllowlist: stringList(purchase.marketAllowlist ?? ["UK"], "purchase.marketAllowlist"),
      currencyAllowlist: stringList(purchase.currencyAllowlist ?? ["GBP"], "purchase.currencyAllowlist"),
      searchAllowlist: searchAllowlist(purchase.searchAllowlist, "purchase.searchAllowlist"),
      maxEventAgeMs: positiveInteger(purchase.maxEventAgeSeconds ?? 120, "purchase.maxEventAgeSeconds", { max: 3600 }) * 1000,
      maxItemPriceMinor: positiveInteger(purchase.maxItemPriceMinor, "purchase.maxItemPriceMinor"),
      maxCheckoutTotalMinor: positiveInteger(purchase.maxCheckoutTotalMinor, "purchase.maxCheckoutTotalMinor"),
      maxDailySpendMinor: positiveInteger(purchase.maxDailySpendMinor, "purchase.maxDailySpendMinor"),
      maxDailyCount: positiveInteger(purchase.maxDailyCount, "purchase.maxDailyCount", { max: 100 }),
      armDurationSeconds: positiveInteger(purchase.armDurationSeconds ?? 900, "purchase.armDurationSeconds", { max: 3600 }),
    },
  };

  if (config.purchase.maxCheckoutTotalMinor < config.purchase.maxItemPriceMinor) {
    throw new TypeError("purchase.maxCheckoutTotalMinor cannot be lower than maxItemPriceMinor");
  }
  if (config.purchase.maxDailySpendMinor < config.purchase.maxCheckoutTotalMinor) {
    throw new TypeError("purchase.maxDailySpendMinor cannot be lower than maxCheckoutTotalMinor");
  }
  return config;
}

export function publicConfig(config) {
  const publicPurchase = { ...config.purchase };
  const storage = config.storage ?? {};
  return {
    vinotify: {
      baseUrl: config.vinotify.baseUrl,
      searchScope: "selected purchase searches",
      longPollSeconds: config.vinotify.longPollSeconds,
      maxConcurrentFeeds: config.vinotify.maxConcurrentFeeds,
      discoveryRefreshSeconds: config.vinotify.discoveryRefreshSeconds,
    },
    browser: { market: "UK", profile: "dedicated local profile" },
    purchase: publicPurchase,
    storage: {
      attemptRetentionDays: storage.attemptRetentionDays,
      logRetentionDays: storage.logRetentionDays,
      maxLogRows: storage.maxLogRows,
      maxDatabaseBytes: storage.maxDatabaseBytes,
      cleanupIntervalSeconds: storage.cleanupIntervalSeconds,
    },
    ui: { ...config.ui },
  };
}
