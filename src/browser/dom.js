import { classifyText, VINTED_SELECTORS } from "./selectors.js";

/**
 * Small Playwright-compatible adapter helpers.  Keeping these operations
 * here means the executor never relies on page.evaluate or browser storage,
 * and tests can provide a Page/Locator-shaped fixture without launching a
 * browser.
 */

export async function firstLocator(page, selectors) {
  if (!page || typeof page.locator !== "function") return null;
  for (const selector of selectors ?? []) {
    try {
      const candidate = page.locator(selector);
      const locator =
        candidate && typeof candidate.first === "function"
          ? candidate.first()
          : candidate;
      if (!locator) continue;
      if (typeof locator.count === "function") {
        const count = await locator.count();
        if (!Number.isFinite(count) || count < 1) continue;
      }
      return { locator, selector };
    } catch {
      // A selector unsupported by a fixture/browser version is not evidence
      // that a page is safe.  Continue to the next explicit selector.
    }
  }
  return null;
}

export async function readLocatorText(locator) {
  if (!locator) return null;
  try {
    if (typeof locator.textContent === "function") {
      const text = await locator.textContent();
      if (text !== null && text !== undefined) return String(text);
    }
  } catch {
    // Try the non-preferred Playwright-compatible method below.
  }
  try {
    if (typeof locator.innerText === "function") {
      const text = await locator.innerText();
      if (text !== null && text !== undefined) return String(text);
    }
  } catch {
    // Missing/unstable DOM is handled as unknown by the caller.
  }
  return null;
}

export async function readLocatorAttribute(locator, name) {
  if (!locator || typeof locator.getAttribute !== "function") return null;
  try {
    const value = await locator.getAttribute(name);
    return value === null || value === undefined ? null : String(value);
  } catch {
    return null;
  }
}

/**
 * Read values from a small, explicit selector set without evaluating code in
 * the page.  Identity evidence is safety-sensitive: duplicate selectors are
 * all inspected when Playwright supports nth(), and conflicting values are
 * reported as ambiguous instead of picking the first element.
 */
export async function readSelectorValues(
  page,
  selectors,
  { attributes = [], parse, maxMatches = 64 } = {},
) {
  const values = [];
  if (!page || typeof page.locator !== "function" || typeof parse !== "function") {
    return { values, ambiguous: true };
  }

  for (const selector of selectors ?? []) {
    let collection;
    try {
      collection = page.locator(selector);
      if (!collection) continue;
    } catch {
      continue;
    }

    let count = 1;
    if (typeof collection.count === "function") {
      try {
        count = await collection.count();
      } catch {
        continue;
      }
      if (!Number.isFinite(count) || count < 1) continue;
      if (count > maxMatches) return { values, ambiguous: true };
    }

    if (count > 1 && typeof collection.nth !== "function") {
      return { values, ambiguous: true };
    }

    for (let index = 0; index < count; index += 1) {
      const locator =
        count > 1
          ? collection.nth(index)
          : typeof collection.first === "function"
            ? collection.first()
            : collection;
      if (!(await locatorIsVisible(locator))) continue;
      const raw = {
        text: await readLocatorText(locator),
      };
      for (const attribute of attributes) {
        raw[attribute] = await readLocatorAttribute(locator, attribute);
      }
      let value;
      try {
        value = parse(raw);
      } catch {
        value = null;
      }
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        values.push(String(value).trim());
      }
    }
  }

  return { values: [...new Set(values)], ambiguous: false };
}
export async function locatorIsVisible(locator) {
  if (!locator) return false;
  if (typeof locator.isVisible !== "function") return true;
  try {
    return Boolean(await locator.isVisible());
  } catch {
    return false;
  }
}

export async function locatorIsEnabled(locator) {
  if (!locator) return false;
  if (typeof locator.isEnabled !== "function") return true;
  try {
    return Boolean(await locator.isEnabled());
  } catch {
    return false;
  }
}

export async function clickLocator(locator) {
  if (!locator || typeof locator.click !== "function") return false;
  await locator.click();
  return true;
}

export async function pageUrl(page) {
  try {
    if (page && typeof page.url === "function") return String(page.url());
  } catch {
    // An unavailable URL is deliberately returned as an empty value.
  }
  return "";
}

export async function pageBodyText(page) {
  const body = await firstLocator(page, VINTED_SELECTORS.page.body);
  return (await readLocatorText(body?.locator)) ?? "";
}

export async function hasVisibleSelector(page, selectors) {
  const match = await firstLocator(page, selectors);
  return Boolean(match && (await locatorIsVisible(match.locator)));
}

/**
 * Classify only the states the executor knows how to handle.  This function
 * never returns an optimistic default; a normal or changed page is unknown.
 */
export async function classifyPageState(page, { readBody = false } = {}) {
  const url = await pageUrl(page);
  // The executor leaves this false.  Reading arbitrary body text on a
  // checkout page could expose saved-card details; only targeted selectors
  // and the URL are sufficient for the fail-closed path.  Tests may opt in
  // when exercising the pure classifier with a fixture.
  const bodyText = readBody ? await pageBodyText(page) : "";

  if (await hasVisibleSelector(page, VINTED_SELECTORS.page.captcha)) {
    return "captcha";
  }
  if (await hasVisibleSelector(page, VINTED_SELECTORS.page.verification)) {
    return "verification_required";
  }
  if (await hasVisibleSelector(page, VINTED_SELECTORS.page.paymentPending)) {
    return "payment_pending";
  }
  if (await hasVisibleSelector(page, VINTED_SELECTORS.page.success)) {
    return "success";
  }
  if (await hasVisibleSelector(page, VINTED_SELECTORS.page.login)) {
    return "login_required";
  }
  return classifyText(bodyText, url);
}
