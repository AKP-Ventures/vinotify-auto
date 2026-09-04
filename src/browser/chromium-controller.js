import { mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  isAllowedVintedUrl,
  VINTED_UK_ORIGIN,
} from "./selectors.js";
import { BrowserAutomationError } from "./errors.js";

const DEFAULT_EXECUTABLES = Object.freeze([
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome for Testing",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
]);

const APPLE_ID_ORIGIN = "https://appleid.apple.com";
const DEFAULT_APPLE_AUTH_WINDOW_MS = 10 * 60_000;

function discoverExecutable(explicit) {
  const candidates = [explicit, process.env.LOCAL_BUY_CHROME_PATH, ...DEFAULT_EXECUTABLES];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function ensureAbsoluteDirectory(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrowserAutomationError(
      "A dedicated absolute Chromium user-data directory is required",
      { code: "BROWSER_PROFILE_REQUIRED" },
    );
  }
  if (!isAbsolute(value)) {
    throw new BrowserAutomationError(
      "Chromium user-data directory must be absolute",
      { code: "BROWSER_PROFILE_REQUIRED" },
    );
  }
  const directory = resolve(value);
  return directory;
}

/**
 * Owns one visible, persistent Chromium context.  No storage-state, cookies,
 * localStorage, or payment values are ever exposed by this class.  The
 * browser profile is the sole place where Vinted authentication and saved
 * payment methods live.
 */
export class ChromiumController {
  #context = null;
  #page = null;
  #launchPromise = null;
  #guardedPages = new WeakSet();
  #appleSignIn = null;
  #clock;

  constructor({
    userDataDir,
    executablePath,
    playwright,
    launchOptions = {},
    // Internal test seam; normal callers use the real clock by default.
    clock = () => Date.now(),
  } = {}) {
    this.userDataDir = ensureAbsoluteDirectory(userDataDir);
    this.executablePath = discoverExecutable(executablePath);
    this.playwright = playwright;
    this.launchOptions = { ...launchOptions };
    this.#clock = typeof clock === "function" ? clock : () => Date.now();

    if (this.launchOptions.headless === true) {
      throw new BrowserAutomationError(
        "The purchasing browser must remain visible",
        { code: "BROWSER_HEADLESS_FORBIDDEN" },
      );
    }
    delete this.launchOptions.headless;
    // Caller-controlled launch options cannot turn the dedicated profile into
    // a headless/background browser.  The persistent profile is intentional.
  }

  get isRunning() {
    return Boolean(this.#context);
  }

  async start() {
    if (this.#context) return this;
    if (this.#launchPromise) return this.#launchPromise;

    this.#launchPromise = this.#startInternal();
    try {
      await this.#launchPromise;
      return this;
    } finally {
      this.#launchPromise = null;
    }
  }

  async #startInternal() {
    await mkdir(this.userDataDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.userDataDir, 0o700);
    } catch {
      // chmod is advisory on platforms/filesystems that do not support it.
    }

    let chromium = this.playwright?.chromium;
    if (!chromium) {
      try {
        ({ chromium } = await import("playwright-core"));
      } catch (cause) {
        throw new BrowserAutomationError(
          "playwright-core is required to launch Chromium",
          { code: "BROWSER_DEPENDENCY_MISSING", cause },
        );
      }
    }

    if (!this.executablePath && !this.launchOptions.channel) {
      throw new BrowserAutomationError(
        "Set LOCAL_BUY_CHROME_PATH or provide a system Chrome executablePath",
        { code: "BROWSER_EXECUTABLE_REQUIRED" },
      );
    }

    const options = {
      ...this.launchOptions,
      headless: false,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
    };

    try {
      this.#context = await chromium.launchPersistentContext(
        this.userDataDir,
        options,
      );
      await this.#installOriginGuards(this.#context);
      const pages = this.#context.pages();
      this.#page = pages[0] ?? (await this.#context.newPage());
      await this.#watchPage(this.#page);
    } catch (cause) {
      const context = this.#context;
      this.#context = null;
      this.#page = null;
      try {
        await context?.close?.();
      } catch {
        // Preserve the original launch/guard error.
      }
      if (cause instanceof BrowserAutomationError && cause.code === "BROWSER_ORIGIN_GUARD_UNAVAILABLE") {
        throw cause;
      }
      throw new BrowserAutomationError("Unable to launch visible Chromium", {
        code: "BROWSER_LAUNCH_FAILED",
        cause,
      });
    }
  }

  async #installOriginGuards(context) {
    if (typeof context?.route !== "function") {
      throw new BrowserAutomationError(
        "Persistent Chromium context cannot install the exact-origin request guard",
        { code: "BROWSER_ORIGIN_GUARD_UNAVAILABLE" },
      );
    }
    // Context-level routing is required for persistent contexts: page-level
    // routing does not cover every popup and redirect created by the
    // profile.  Subresources and child-frame navigations are allowed; only
    // a main-frame document request is origin-sensitive.
    await context.route("**/*", (route) => this.#handleRoute(route));
    if (typeof context.on === "function") {
      context.on("page", (page) => {
        void this.#watchPage(page).catch(() => {});
      });
    }
    for (const page of context.pages?.() ?? []) await this.#watchPage(page);
  }

  async #handleRoute(route) {
    const request = route?.request?.();
    const url = requestUrl(request);
    const page = requestPage(request);
    const appleAuthNavigation =
      isMainFrameNavigationRequest(request) &&
      await this.#isAllowedAppleAuthNavigation(page, url);
    if (
      isMainFrameNavigationRequest(request) &&
      !isSafeInitialPageUrl(url) &&
      !isAllowedVintedUrl(url) &&
      !appleAuthNavigation
    ) {
      const popup = await isPopupPage(page);
      if (typeof route.abort !== "function") {
        if (popup) await closePage(page);
        throw new BrowserAutomationError(
          "The browser route cannot abort a forbidden main-frame navigation",
          { code: "BROWSER_ORIGIN_ABORT_UNAVAILABLE" },
        );
      }
      try {
        await route.abort("blockedbyclient");
      } catch {
        // The browser may have closed the route while a popup was closing.
      } finally {
        if (popup) await closePage(page);
      }
      return;
    }
    if (isAllowedVintedUrl(url)) this.#completeAppleSignIn(page);
    if (typeof route.continue === "function") {
      await route.continue();
    } else if (typeof route.fallback === "function") {
      await route.fallback();
    }
  }

  async #watchPage(page) {
    if (!page || this.#guardedPages.has(page)) return;
    this.#guardedPages.add(page);

    if (typeof page.on === "function") {
      page.on("popup", (popup) => {
        void this.#watchPage(popup).catch(() => {});
      });
      page.on("close", () => {
        if (
          this.#appleSignIn?.opener === page ||
          this.#appleSignIn?.popup === page
        ) {
          this.#appleSignIn = null;
        }
      });
      page.on("framenavigated", (frame) => {
        void this.#handleFrameNavigated(frame, page).catch(() => {});
      });
    }

    await this.#checkInitialPage(page);
  }

  async #handleFrameNavigated(frame, fallbackPage) {
    try {
      if (typeof frame?.parentFrame === "function" && frame.parentFrame() !== null) return;
      const url = typeof frame?.url === "function" ? String(frame.url()) : "";
      const framePage = typeof frame?.page === "function" ? frame.page() : fallbackPage;
      if (isAllowedAppleIdUrl(url) && await this.#isAllowedAppleAuthNavigation(framePage, url)) {
        return;
      }
      if (isSafeInitialPageUrl(url) || isAllowedVintedUrl(url)) {
        if (isAllowedVintedUrl(url)) this.#completeAppleSignIn(framePage);
        return;
      }
      if (await isPopupPage(framePage)) void closePage(framePage);
    } catch {
      // Navigation interception remains the primary guard; event hooks are
      // defense in depth and must never make the visible UI crash.
    }
  }

  async #checkInitialPage(page) {
    // A popup may have been created before the context page event listener
    // ran.  A route aborts its cross-origin document request; this closes any
    // already-navigated popup left by a non-Playwright fixture/browser.
    try {
      const url = typeof page.url === "function" ? String(page.url()) : "";
      const appleAllowed =
        isAllowedAppleIdUrl(url) &&
        await this.#isAllowedAppleAuthNavigation(page, url);
      if (
        !isPageCreationUrl(url) &&
        !isAllowedVintedUrl(url) &&
        !appleAllowed &&
        await isPopupPage(page)
      ) {
        void closePage(page);
      }
    } catch {
      // No URL is not evidence that a page is safe; the route handler covers
      // the actual document request.
    }
  }

  async page() {
    await this.start();
    if (!this.#page || this.#page.isClosed?.()) {
      const pages = this.#context?.pages?.() ?? [];
      this.#page = pages[0] ?? (await this.#context.newPage());
    }
    return this.#page;
  }

  async navigate(url) {
    if (!isAllowedVintedUrl(url)) {
      throw new BrowserAutomationError(
        `Navigation outside ${VINTED_UK_ORIGIN} is blocked`,
        { code: "BROWSER_ORIGIN_BLOCKED" },
      );
    }
    const page = await this.page();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (cause) {
      throw new BrowserAutomationError("Vinted navigation failed", {
        code: "BROWSER_NAVIGATION_FAILED",
        cause,
      });
    }
    const current = typeof page.url === "function" ? page.url() : "";
    if (!isAllowedVintedUrl(current)) {
      throw new BrowserAutomationError(
        "The browser navigated outside the exact Vinted UK origin",
        { code: "BROWSER_ORIGIN_BLOCKED" },
      );
    }
    return page;
  }

  async bringToFront() {
    const page = await this.page();
    if (typeof page.bringToFront === "function") await page.bringToFront();
  }

  async close() {
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    this.#appleSignIn = null;
    if (context && typeof context.close === "function") {
      await context.close();
    }
  }

  async #isAllowedAppleAuthNavigation(page, url) {
    if (!isAllowedAppleIdUrl(url)) return false;
    const opener = await pageOpener(page);
    if (
      !opener ||
      opener !== this.#page ||
      await isPopupPage(opener) ||
      !isAllowedVintedUrl(pageUrlValue(opener))
    ) return false;

    const state = this.#appleSignIn;
    if (!state) {
      if (!isAllowedAppleAuthorizeUrl(url)) return false;
      // The first exact authorize request from an exact Vinted opener is the
      // user-visible Sign in with Apple flow.  Keep the exception to this
      // popup and consume it when the popup returns to Vinted.
      this.#appleSignIn = {
        opener,
        popup: page,
        expiresAt: this.#clock() + DEFAULT_APPLE_AUTH_WINDOW_MS,
      };
      return true;
    }
    if (state.opener !== opener) return false;
    if (state.expiresAt <= this.#clock()) {
      // Keep an expired popup bound until it closes.  Otherwise a replayed
      // authorize request in the same popup could silently re-arm the flow.
      if (state.popup === page || !isAllowedAppleAuthorizeUrl(url)) return false;
      this.#appleSignIn = {
        opener,
        popup: page,
        expiresAt: this.#clock() + DEFAULT_APPLE_AUTH_WINDOW_MS,
      };
      return true;
    }
    if (state.completed) {
      // A callback consumes this popup. A newly-created popup may begin a
      // later explicit login, but the callback popup cannot replay Apple.
      if (state.popup === page || !isAllowedAppleAuthorizeUrl(url)) return false;
      this.#appleSignIn = {
        opener,
        popup: page,
        expiresAt: this.#clock() + DEFAULT_APPLE_AUTH_WINDOW_MS,
      };
      return true;
    }
    return state.popup === page;
  }

  #completeAppleSignIn(page) {
    if (this.#appleSignIn?.popup === page) this.#appleSignIn.completed = true;
  }
}

function requestUrl(request) {
  try {
    return typeof request?.url === "function" ? String(request.url()) : "";
  } catch {
    return "";
  }
}

function pageUrlValue(page) {
  try {
    return typeof page?.url === "function" ? String(page.url()) : "";
  } catch {
    return "";
  }
}

async function pageOpener(page) {
  try {
    if (typeof page?.opener !== "function") return null;
    return await page.opener();
  } catch {
    return null;
  }
}

function requestFrame(request) {
  try {
    return typeof request?.frame === "function" ? request.frame() : null;
  } catch {
    return null;
  }
}

function requestPage(request) {
  const frame = requestFrame(request);
  try {
    return typeof frame?.page === "function" ? frame.page() : null;
  } catch {
    return null;
  }
}

function isMainFrameNavigationRequest(request) {
  if (!request) return true;
  let navigation = false;
  try {
    if (typeof request.isNavigationRequest === "function") {
      navigation = Boolean(request.isNavigationRequest());
    } else {
      const resourceType = request.resourceType?.();
      // Unknown request metadata is treated as a document so a fixture or
      // browser API change cannot silently weaken the origin boundary.
      navigation = resourceType === "document" || resourceType === undefined;
    }
  } catch {
    navigation = true;
  }
  if (!navigation) return false;

  const frame = requestFrame(request);
  if (!frame) return true;
  try {
    return typeof frame.parentFrame !== "function" || frame.parentFrame() == null;
  } catch {
    return true;
  }
}

function isSafeInitialPageUrl(url) {
  return String(url ?? "").trim().toLowerCase() === "about:blank";
}

function isPageCreationUrl(url) {
  return url === "" || isSafeInitialPageUrl(url);
}

function isAllowedAppleIdUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "appleid.apple.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.origin === APPLE_ID_ORIGIN
    );
  } catch {
    return false;
  }
}

function isAllowedAppleAuthorizeUrl(value) {
  try {
    const url = new URL(value);
    return isAllowedAppleIdUrl(value) && url.pathname === "/auth/authorize";
  } catch {
    return false;
  }
}

async function isPopupPage(page) {
  return Boolean(await pageOpener(page));
}

async function closePage(page) {
  try {
    if (page && typeof page.close === "function" && !page.isClosed?.()) {
      await page.close();
    }
  } catch {
    // Popup closure is best effort after the request has already been blocked.
  }
}

export function resolveChromeExecutable(explicit) {
  return discoverExecutable(explicit);
}
