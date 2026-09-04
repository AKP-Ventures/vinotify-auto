# Browser selector contract

The browser adapter treats Vinted's DOM as an external, versioned boundary.
All selectors live in `src/browser/selectors.js`; do not scatter CSS selectors
through the executor or use broad text searches as a fallback.

Each selector change must include a fixture test for:

1. Listing item ID, explicit availability, live price, currency, and enabled
   purchase action.
2. Checkout total and currency, a selected saved-payment label, and an
   enabled final payment action.
3. Login, CAPTCHA, verification, pending-payment, success, and unknown page
   states.

The adapter may return `unknown` if a selector is absent, duplicated,
ambiguous, disabled, or changed. A real browser test must be run manually in
the visible dedicated profile before a selector update is trusted. Do not add
selectors that read `input` values, card numbers, cookies, local storage,
one-time passcodes, or CAPTCHA/verification answers. Payment-method parsing
must return only `Saved card` or `Vinted Balance`.

The final payment selector is an irreversible boundary: after one attempted
click, the executor returns `payment_pending` until reconciliation proves
success or another explicit terminal state. There is no retry path.

Reconciliation is identity-bound. A success banner, `/orders/` path, or an
old confirmation page is never sufficient on its own. The page must expose one
unambiguous, visible item identity matching the attempted `itemId`; when the
attempt already has an `orderId`, an unambiguous order identity must match that
ID as well. Identity is read only through the explicit selectors under
`VINTED_SELECTORS.reconciliation` with Locator APIs (`count`, `nth`, text and
attributes); `evaluate`, cookies, storage state, and arbitrary page text are
forbidden. Missing, conflicting, or mismatching evidence remains `unknown` and
keeps the payment guard engaged.

The persistent Chromium context installs a context-level request route before
the first page is used. Exact `https://www.vinted.co.uk` main-frame documents
are allowed; cross-origin main-frame redirects and popup documents are aborted
before loading. Cross-origin subresources and child-frame navigations are
allowed because they cannot become the main page through this route; a child
frame attempting to navigate the top-level page is intercepted as a main-frame
request. Popup pages are closed as defense in depth. Login, CAPTCHA, and
verification pages remain visible and are never bypassed by the browser guard.
