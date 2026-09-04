import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ChromiumController } from "../../src/browser/chromium-controller.js";
import { BrowserAutomationError } from "../../src/browser/errors.js";

class FakePage {
  constructor() {
    this.currentUrl = "about:blank";
  }
  url() {
    return this.currentUrl;
  }
  async goto(url) {
    this.currentUrl = url;
  }
  async bringToFront() {}
  isClosed() {
    return false;
  }
}

class GuardPage extends FakePage {
  constructor(url = "about:blank", opener = null) {
    super();
    this.currentUrl = url;
    this.pageOpener = opener;
    this.listeners = new Map();
    this.closed = false;
  }
  on(event, listener) {
    this.listeners.set(event, listener);
  }
  opener() {
    return this.pageOpener;
  }
  async close() {
    this.closed = true;
  }
  isClosed() {
    return this.closed;
  }
}

class AsyncGuardPage extends GuardPage {
  // Matches Playwright 1.55 Page.opener(): Promise<Page | null>.
  async opener() {
    return this.pageOpener;
  }
}

class GuardFrame {
  constructor(page, parent = null) {
    this.targetPage = page;
    this.parent = parent;
  }
  parentFrame() {
    return this.parent;
  }
  page() {
    return this.targetPage;
  }
}

class GuardRequest {
  constructor(url, { frame, navigation = true, resourceType = "document" } = {}) {
    this.targetUrl = url;
    this.targetFrame = frame;
    this.navigation = navigation;
    this.type = resourceType;
  }
  url() {
    return this.targetUrl;
  }
  frame() {
    return this.targetFrame;
  }
  isNavigationRequest() {
    return this.navigation;
  }
  resourceType() {
    return this.type;
  }
}

class GuardRoute {
  constructor(request) {
    this.targetRequest = request;
    this.actions = [];
  }
  request() {
    return this.targetRequest;
  }
  async abort(reason) {
    this.actions.push(["abort", reason]);
  }
  async continue() {
    this.actions.push(["continue"]);
  }
}

class NoAbortRoute {
  constructor(request) {
    this.targetRequest = request;
    this.fallbackCalled = false;
  }
  request() {
    return this.targetRequest;
  }
  async fallback() {
    this.fallbackCalled = true;
  }
}

class GuardContext {
  constructor(pages) {
    this.pageList = pages;
    this.listeners = new Map();
    this.routeHandler = null;
  }
  pages() {
    return this.pageList;
  }
  async newPage() {
    const page = new GuardPage();
    this.pageList.push(page);
    return page;
  }
  async route(_pattern, handler) {
    this.routeHandler = handler;
  }
  on(event, listener) {
    this.listeners.set(event, listener);
  }
  async close() {}
}

class ArcContext extends GuardContext {
  constructor(pages) {
    super(pages);
    this.closed = 0;
  }
  async close() {
    this.closed += 1;
  }
}

test("controller launches a visible persistent system-Chrome context", async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-profile-"));
  const page = new FakePage();
  const calls = [];
  const context = {
    pages: () => [],
    async route() {},
    on() {},
    async newPage() {
      return page;
    },
    async close() {
      calls.push({ type: "close" });
    },
  };
  const playwright = {
    chromium: {
      async launchPersistentContext(userDataDir, options) {
        calls.push({ type: "launch", userDataDir, options });
        return context;
      },
    },
  };
  const controller = new ChromiumController({
    userDataDir: profile,
    playwright,
    launchOptions: { channel: "chrome" },
  });
  await controller.start();
  assert.equal(calls[0].options.headless, false);
  assert.equal(calls[0].options.channel, "chrome");
  assert.equal(calls[0].userDataDir, profile);
  assert.equal(controller.isRunning, true);
  await controller.navigate("https://www.vinted.co.uk/items/12345-coat");
  await assert.rejects(
    () => controller.navigate("https://www.vinted.com/items/12345-coat"),
    (error) => error instanceof BrowserAutomationError && error.code === "BROWSER_ORIGIN_BLOCKED",
  );
  await controller.close();
  assert.deepEqual(calls.at(-1), { type: "close" });
  await rm(profile, { recursive: true, force: true });
});

test("controller rejects relative profiles and headless mode", () => {
  assert.throws(
    () => new ChromiumController({ userDataDir: "relative-profile", launchOptions: { channel: "chrome" } }),
    (error) => error instanceof BrowserAutomationError && error.code === "BROWSER_PROFILE_REQUIRED",
  );
  assert.throws(
    () => new ChromiumController({ userDataDir: "/tmp/local-buy-agent-test", launchOptions: { headless: true } }),
    (error) => error instanceof BrowserAutomationError && error.code === "BROWSER_HEADLESS_FORBIDDEN",
  );
});

test("context guard aborts cross-origin main documents before load and allows Vinted paths", async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-profile-"));
  const page = new GuardPage();
  const context = new GuardContext([page]);
  const controller = new ChromiumController({
    userDataDir: profile,
    playwright: {
      chromium: {
        async launchPersistentContext() {
          return context;
        },
      },
    },
    launchOptions: { channel: "chrome" },
  });
  await controller.start();

  const mainFrame = new GuardFrame(page);
  const external = new GuardRoute(new GuardRequest("https://evil.example/redirect", {
    frame: mainFrame,
  }));
  await context.routeHandler(external);
  assert.deepEqual(external.actions, [["abort", "blockedbyclient"]]);

  const allowed = new GuardRoute(new GuardRequest("https://www.vinted.co.uk/orders/987", {
    frame: mainFrame,
  }));
  await context.routeHandler(allowed);
  assert.deepEqual(allowed.actions, [["continue"]]);

  const subresource = new GuardRoute(new GuardRequest("https://cdn.example/script.js", {
    frame: mainFrame,
    navigation: false,
    resourceType: "script",
  }));
  await context.routeHandler(subresource);
  assert.deepEqual(subresource.actions, [["continue"]]);

  const childFrame = new GuardFrame(page, mainFrame);
  const iframeNavigation = new GuardRoute(new GuardRequest("https://payments.example/frame", {
    frame: childFrame,
  }));
  await context.routeHandler(iframeNavigation);
  assert.deepEqual(iframeNavigation.actions, [["continue"]]);

  await controller.close();
  await rm(profile, { recursive: true, force: true });
});

test("context guard aborts and closes cross-origin popups", async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-profile-"));
  const page = new GuardPage();
  const popup = new GuardPage("about:blank", page);
  const context = new GuardContext([page, popup]);
  const controller = new ChromiumController({
    userDataDir: profile,
    playwright: {
      chromium: {
        async launchPersistentContext() {
          return context;
        },
      },
    },
    launchOptions: { channel: "chrome" },
  });
  await controller.start();

  const popupFrame = new GuardFrame(popup);
  const popupRoute = new GuardRoute(new GuardRequest("https://evil.example/popup", {
    frame: popupFrame,
  }));
  await context.routeHandler(popupRoute);
  assert.deepEqual(popupRoute.actions, [["abort", "blockedbyclient"]]);
  assert.equal(popup.closed, true);

  await controller.close();
  await rm(profile, { recursive: true, force: true });
});

test("Apple sign-in allows an exact authorize popup and consumes it on Vinted callback", async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-profile-"));
  const page = new GuardPage("https://www.vinted.co.uk/login");
  const context = new GuardContext([page]);
  const controller = new ChromiumController({
    userDataDir: profile,
    playwright: {
      chromium: {
        async launchPersistentContext() {
          return context;
        },
      },
    },
    launchOptions: { channel: "chrome" },
  });
  await controller.start();

  const wrongPathPopup = new GuardPage("about:blank", page);
  const wrongPathRoute = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/authorize/extra?client_id=vinted", {
    frame: new GuardFrame(wrongPathPopup),
  }));
  await context.routeHandler(wrongPathRoute);
  assert.deepEqual(wrongPathRoute.actions, [["abort", "blockedbyclient"]]);
  assert.equal(wrongPathPopup.closed, true);

  const popup = new GuardPage("about:blank", page);
  const popupFrame = new GuardFrame(popup);
  const appleRoute = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/authorize?client_id=vinted", {
    frame: popupFrame,
  }));
  await context.routeHandler(appleRoute);
  assert.deepEqual(appleRoute.actions, [["continue"]]);
  assert.equal(popup.closed, false);
  popup.currentUrl = "https://appleid.apple.com/auth/authorize?client_id=vinted";
  await context.listeners.get("page")?.(popup);
  assert.equal(popup.closed, false);

  const callbackRoute = new GuardRoute(new GuardRequest("https://www.vinted.co.uk/oauth/callback?code=redacted", {
    frame: popupFrame,
  }));
  await context.routeHandler(callbackRoute);
  assert.deepEqual(callbackRoute.actions, [["continue"]]);

  const replayRoute = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/authorize?client_id=vinted", {
    frame: popupFrame,
  }));
  await context.routeHandler(replayRoute);
  assert.deepEqual(replayRoute.actions, [["abort", "blockedbyclient"]]);
  assert.equal(popup.closed, true);

  await controller.close();
  await rm(profile, { recursive: true, force: true });
});

test("Apple exception handles Promise openers, remains popup-bound, expires, and blocks main-frame navigation", async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-profile-"));
  const page = new AsyncGuardPage("https://www.vinted.co.uk/login");
  const otherPage = new AsyncGuardPage("https://www.vinted.co.uk/");
  const context = new GuardContext([page, otherPage]);
  let now = 100_000;
  const controller = new ChromiumController({
    userDataDir: profile,
    playwright: {
      chromium: {
        async launchPersistentContext() {
          return context;
        },
      },
    },
    launchOptions: { channel: "chrome" },
    clock: () => now,
  });
  await controller.start();

  const mainFrameApple = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/authorize", {
    frame: new GuardFrame(page),
  }));
  await context.routeHandler(mainFrameApple);
  assert.deepEqual(mainFrameApple.actions, [["abort", "blockedbyclient"]]);

  const foreignOpenerPopup = new AsyncGuardPage("about:blank", otherPage);
  const foreignPopupRoute = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/authorize", {
    frame: new GuardFrame(foreignOpenerPopup),
  }));
  await context.routeHandler(foreignPopupRoute);
  assert.deepEqual(foreignPopupRoute.actions, [["abort", "blockedbyclient"]]);
  assert.equal(foreignOpenerPopup.closed, true);

  for (const url of [
    "https://appleid.apple.com.evil.example/auth/authorize",
    "http://appleid.apple.com/auth/authorize",
    "https://appleid.apple.com.evil/auth/authorize",
    "https://appleid.apple.com@evil.example/auth/authorize",
    "https://user:secret@appleid.apple.com/auth/authorize",
    "https://appleid.apple.com:444/auth/authorize",
    "https://appleid.apple.com/",
    "https://appleid.apple.com/auth/login",
    "https://appleid.apple.com/auth/authorize/extra",
  ]) {
    const malformedPopup = new AsyncGuardPage("about:blank", page);
    const malformedFrame = new GuardFrame(malformedPopup);
    const route = new GuardRoute(new GuardRequest(url, { frame: malformedFrame }));
    await context.routeHandler(route);
    assert.deepEqual(route.actions, [["abort", "blockedbyclient"]], url);
    assert.equal(malformedPopup.closed, true);
  }

  const emptyInitialPopup = new AsyncGuardPage("", page);
  context.listeners.get("page")?.(emptyInitialPopup);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emptyInitialPopup.closed, false);

  const evilAfterEmptyInitial = new AsyncGuardPage("", page);
  context.listeners.get("page")?.(evilAfterEmptyInitial);
  await new Promise((resolve) => setImmediate(resolve));
  const evilAfterEmptyInitialRoute = new GuardRoute(new GuardRequest("https://evil.example/redirect", {
    frame: new GuardFrame(evilAfterEmptyInitial),
  }));
  await context.routeHandler(evilAfterEmptyInitialRoute);
  assert.deepEqual(evilAfterEmptyInitialRoute.actions, [["abort", "blockedbyclient"]]);
  assert.equal(evilAfterEmptyInitial.closed, true);

  const emptyUrlRoute = new GuardRoute(new GuardRequest("", {
    frame: new GuardFrame(page),
  }));
  await context.routeHandler(emptyUrlRoute);
  assert.deepEqual(emptyUrlRoute.actions, [["abort", "blockedbyclient"]]);

  const unreadableUrlRequest = {
    url() {
      throw new Error("request URL unavailable");
    },
    frame() {
      return new GuardFrame(page);
    },
    isNavigationRequest() {
      return true;
    },
  };
  const unreadableUrlRoute = new GuardRoute(unreadableUrlRequest);
  await context.routeHandler(unreadableUrlRoute);
  assert.deepEqual(unreadableUrlRoute.actions, [["abort", "blockedbyclient"]]);

  const popup = emptyInitialPopup;
  const popupFrame = new GuardFrame(popup);
  const authorizeRoute = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/authorize?client_id=vinted", {
    frame: popupFrame,
  }));
  await context.routeHandler(authorizeRoute);
  assert.deepEqual(authorizeRoute.actions, [["continue"]]);
  assert.equal(popup.closed, false);

  const arbitraryApplePath = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/account", {
    frame: popupFrame,
  }));
  await context.routeHandler(arbitraryApplePath);
  assert.deepEqual(arbitraryApplePath.actions, [["continue"]]);
  assert.equal(popup.closed, false);

  const secondPopup = new AsyncGuardPage("about:blank", page);
  const secondPopupRoute = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/account", {
    frame: new GuardFrame(secondPopup),
  }));
  await context.routeHandler(secondPopupRoute);
  assert.deepEqual(secondPopupRoute.actions, [["abort", "blockedbyclient"]]);
  assert.equal(secondPopup.closed, true);

  now += (10 * 60 * 1000) + 1;
  const expiredRoute = new GuardRoute(new GuardRequest("https://appleid.apple.com/auth/authorize", {
    frame: popupFrame,
  }));
  await context.routeHandler(expiredRoute);
  assert.deepEqual(expiredRoute.actions, [["abort", "blockedbyclient"]]);
  assert.equal(popup.closed, true);

  await controller.close();
  await rm(profile, { recursive: true, force: true });
});

test("forbidden main navigation fails closed when route abort is unavailable", async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-profile-"));
  const page = new GuardPage();
  const context = new GuardContext([page]);
  const controller = new ChromiumController({
    userDataDir: profile,
    playwright: {
      chromium: {
        async launchPersistentContext() {
          return context;
        },
      },
    },
    launchOptions: { channel: "chrome" },
  });
  await controller.start();

  const route = new NoAbortRoute(new GuardRequest("https://evil.example/redirect", {
    frame: new GuardFrame(page),
  }));
  await assert.rejects(
    () => context.routeHandler(route),
    (error) => error instanceof BrowserAutomationError && error.code === "BROWSER_ORIGIN_ABORT_UNAVAILABLE",
  );
  assert.equal(route.fallbackCalled, false);

  await controller.close();
  await rm(profile, { recursive: true, force: true });
});

const ARC_EXECUTABLE = "/Applications/Arc.app/Contents/MacOS/Arc";
const ARC_AVAILABLE = process.platform === "darwin" && existsSync(ARC_EXECUTABLE);

test("Arc uses the dedicated persistent profile with a bounded native launch", {
  skip: !ARC_AVAILABLE,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-arc-profile-"));
  const page = new GuardPage();
  const context = new ArcContext([page]);
  const calls = [];
  const controller = new ChromiumController({
    userDataDir: profile,
    executablePath: ARC_EXECUTABLE,
    playwright: {
      chromium: {
        async launchPersistentContext(userDataDir, options) {
          calls.push({ userDataDir, options });
          return context;
        },
      },
    },
    launchOptions: { timeout: 321 },
  });

  await controller.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userDataDir, profile);
  assert.equal(calls[0].options.executablePath, ARC_EXECUTABLE);
  assert.equal(calls[0].options.headless, false);
  assert.equal(calls[0].options.timeout, 321);
  assert.equal(typeof context.routeHandler, "function", "origin guard must be installed before navigation");
  await controller.navigate("https://www.vinted.co.uk/");
  assert.equal(page.url(), "https://www.vinted.co.uk/");
  await controller.close();
  assert.equal(context.closed, 1);
  await rm(profile, { recursive: true, force: true });
});

test("Arc launch timeout is surfaced as an actionable normal-instance conflict", {
  skip: !ARC_AVAILABLE,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "local-buy-agent-arc-conflict-"));
  const calls = [];
  const controller = new ChromiumController({
    userDataDir: profile,
    executablePath: ARC_EXECUTABLE,
    playwright: {
      chromium: {
        async launchPersistentContext(_userDataDir, options) {
          calls.push(options);
          throw new Error("launch timeout");
        },
      },
    },
    launchOptions: { timeout: 30_000 },
  });

  await assert.rejects(
    () => controller.start(),
    (error) =>
      error instanceof BrowserAutomationError &&
      error.code === "BROWSER_ARC_INSTANCE_CONFLICT" &&
      error.message.includes("close the normal Arc instance"),
  );
  assert.equal(calls[0].timeout, 15_000);
  await rm(profile, { recursive: true, force: true });
});

test("Arc refuses the personal profile path", { skip: !ARC_AVAILABLE }, () => {
  const personalProfile = resolve(
    homedir(),
    "Library/Application Support/Arc/User Data",
  );
  assert.throws(
    () => new ChromiumController({
      userDataDir: personalProfile,
      executablePath: ARC_EXECUTABLE,
    }),
    (error) =>
      error instanceof BrowserAutomationError &&
      error.code === "BROWSER_PERSONAL_PROFILE_FORBIDDEN",
  );
});
