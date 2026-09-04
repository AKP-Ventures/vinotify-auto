import { classifyText, VINTED_SELECTORS } from "./selectors.js";

class AmbiguousSelectorError extends Error {}

/**
 * Small Playwright-compatible adapter helpers.  Keeping these operations
 * here means the executor never relies on page.evaluate or browser storage,
 * and tests can provide a Page/Locator-shaped fixture without launching a
 * browser.
 */

async function resolveSelector(page, selector) {
  if (!page || !selector) return null;
  if (typeof selector === "string") {
    if (typeof page.locator !== "function") return null;
    return page.locator(selector);
  }
  if (typeof selector !== "object") return null;

  if (selector.kind === "role") {
    if (typeof page.getByRole !== "function") return null;
    return page.getByRole(selector.role, selector.options ?? {});
  }
  if (selector.kind === "text") {
    if (typeof page.getByText !== "function") return null;
    return page.getByText(selector.value, selector.options ?? {});
  }
  if (selector.kind === "within-heading") {
    if (typeof page.getByRole !== "function") return null;
    const heading = page.getByRole("heading", {
      name: selector.heading,
      exact: selector.options?.exact ?? true,
    });
    if (!heading) return null;
    if (typeof heading.count === "function") {
      let count;
      try {
        count = await heading.count();
      } catch {
        return null;
      }
      if (!Number.isFinite(count) || count < 1) return null;
      if (count !== 1) throw new AmbiguousSelectorError("heading selector matched multiple elements");
    }
    if (typeof heading.locator !== "function") return null;
    const parent = heading.locator("xpath=..");
    if (!parent || typeof parent.getByText !== "function") return null;
    return parent.getByText(selector.pattern);
  }
  return null;
}

export async function firstLocator(page, selectors) {
  if (
    !page ||
    (typeof page.locator !== "function" &&
      typeof page.getByRole !== "function" &&
      typeof page.getByText !== "function")
  ) return null;
  for (const selector of selectors ?? []) {
    try {
      // Semantic descriptors use page.getByRole/getByText and therefore do
      // not require page.locator.  CSS selectors remain available for the
      // explicit compatibility contract and test fixtures.
      const candidate = await resolveSelector(page, selector);
      const locator = candidate;
      if (!locator) continue;
      if (typeof locator.count === "function") {
        const count = await locator.count();
        if (!Number.isFinite(count) || count < 1) continue;
        // A duplicated control or value is not safe evidence.  Do not pick
        // the first match merely because it happens to be clickable.
        if (count !== 1) return null;
      }
      return { locator, selector };
    } catch (error) {
      if (error instanceof AmbiguousSelectorError) return null;
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
  {
    attributes = [],
    parse,
    maxMatches = 64,
    rejectParseFailure = false,
    rejectDuplicateMatches = false,
  } = {},
) {
  const values = [];
  if (
    !page ||
    (typeof page.locator !== "function" &&
      typeof page.getByRole !== "function" &&
      typeof page.getByText !== "function") ||
    typeof parse !== "function"
  ) {
    return { values, ambiguous: true };
  }

  for (const selector of selectors ?? []) {
    let collection;
    try {
      collection = await resolveSelector(page, selector);
      if (!collection) continue;
    } catch (error) {
      if (error instanceof AmbiguousSelectorError) return { values, ambiguous: true };
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

    const selectorValues = [];
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
      if (rejectParseFailure && (raw.text !== null || attributes.some((attribute) => raw[attribute] !== null))) {
        if (value === null || value === undefined || String(value).trim() === "") {
          return { values: [...new Set(values)], ambiguous: true };
        }
      }
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        const normalized = String(value).trim();
        if (rejectDuplicateMatches && selectorValues.includes(normalized)) {
          return { values: [...new Set(values)], ambiguous: true };
        }
        selectorValues.push(normalized);
        values.push(normalized);
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
  for (const selector of selectors ?? []) {
    const match = await firstLocator(page, [selector]);
    if (match && (await locatorIsVisible(match.locator))) return true;
    // A duplicate state marker is unsafe to dismiss as "not present".  Treat
    // it as visible evidence so callers remain blocked until the page is
    // unambiguous again.
    if (!match) {
      try {
        const candidate = await resolveSelector(page, selector);
        if (candidate && typeof candidate.count === "function" && (await candidate.count()) > 1) {
          return true;
        }
      } catch (error) {
        if (error instanceof AmbiguousSelectorError) return true;
      }
    }
  }
  return false;
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
