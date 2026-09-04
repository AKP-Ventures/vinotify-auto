# Vinotify Auto

Vinotify Auto is an unofficial, open-source, user-operated purchasing
companion for Vinotify's read-only event feed. It is not affiliated with,
endorsed by, or supported by Vinotify or Vinted, and is not an official
Vinotify product. All browser activity and purchase state stay on the user's
device. The user is responsible for deciding whether automation is appropriate
for their account and for every purchase it may prepare or submit.

This project is intended to be cloned and run from its standalone GitHub
repository. It is not published as an npm package:

```sh
git clone git@github.com:AKP-Ventures/vinotify-auto.git
cd vinotify-auto
```

The package remains private intentionally; `npm ci` installs its local runtime
dependencies after cloning.

## Current status

The browser adapter is deliberately fail-closed and supports only the UK
Vinted HTTPS origin (`https://www.vinted.co.uk`), a single visible desktop
Chromium profile, and the selector contract in
[`docs/BROWSER_SELECTOR_CONTRACT.md`](docs/BROWSER_SELECTOR_CONTRACT.md).
Vinted's live DOM is not a stable public API. The selectors and checkout flow
must be verified against a test account in `human_final` before any further
experimentation. A changed or unrecognised page returns `unknown` and is not
clicked. The public release does not support automatic payment submission.

The durable core, browser adapter, feed client, and local control UI are wired
into a runnable Node application. The control UI is loopback-only. It has no
analytics, telemetry, remote control endpoint, CDN asset, or cloud dependency.

## Vinotify transport

The companion uses Vinotify's versioned HTTPS REST integration endpoints for
search discovery and event long-polling. REST is the recommended transport for
this persistent local application: it keeps the feed cursor and retry behavior
inside the agent and does not require an AI client or an MCP SDK.

Set `vinotify.baseUrl` to the exact origin `https://vinotify.me`. Do not point it
at the MCP endpoint, a proxy, another host, or another Vinotify market. The
same kind of read-only integration token can also be used by Vinotify's MCP
server, but MCP is intended for interactive AI clients such as Codex, Claude
Code, or Cursor and is optional for this app. Never paste a bearer token into an
AI prompt, source file, issue, log, or public repository.

The companion's REST contract is deliberately small:

- `GET /api/v1/integrations/discovery/v2` returns the account fingerprint and
  active searches used to validate the local allowlist.
- `GET /api/v1/integrations/searches/{search_id}/webhook/events` reads one
  search's versioned event stream. The app supplies its durable `cursor`, a
  `wait_seconds` value of at most 30, and the bearer token in the
  `Authorization` header.
- A `410 cursor_expired` response stops that feed and requires an explicit,
  disarming cursor reset; the companion never skips a retention gap silently.

Vinotify limits each token to 240 requests per minute. The default polling
settings are designed to stay comfortably below that limit; do not combine a
short poll interval with unnecessary concurrency.

## Setup

1. In Vinotify, create a read-only integration token for your account. Copy
   the token when it is shown; it cannot be retrieved again. Use a separate
   read-only token for each companion installation so it can be revoked without
   disrupting other integrations. A read-only token is sufficient; no write
   token is needed.
2. Before arming purchases, obtain the integer IDs for the searches you
   explicitly want this local companion to handle. Put only those IDs in
   `purchase.searchAllowlist`; this is required and must not be left empty. The
   token's discovery scope may include all account searches, but the local
   allowlist is the purchase safety boundary: a newly created or discovered
   search is not eligible until its ID is deliberately added.

   For example, this allows only searches `1234` and `5678`:

   ```json
   {
     "purchase": {
       "mode": "dry_run",
       "searchAllowlist": [1234, 5678]
     }
   }
   ```

   Missing, empty, guessed, or non-integer IDs must fail closed. Review the
   search list returned by Vinotify before adding an ID; never use a wildcard
   or an account-wide selection for a purchase-enabled setup.
3. Run `npm ci` in this directory, copy `config.example.json` to
   `config.local.json` (ignored by Git), and set the exact base URL, token,
   allowlist, absolute/relative dedicated browser profile path, and purchase
   limits. If the token is stored in the config on macOS/Linux, the file must be
   owner-only (`chmod 600`); startup fails closed if group/other permissions are
   present. The example intentionally omits the token: alternatively supply
   `LOCAL_BUY_VINOTIFY_TOKEN` in the process environment.
4. Validate without launching a browser:

   ```sh
   npm start -- --config /absolute/path/to/config.json --check-config
   ```

5. Start the app:

   ```sh
   npm start -- --config /absolute/path/to/config.json
   ```

   Sign in manually in the visible Vinted window, then open the printed
   `http://127.0.0.1:...` control URL. Every restart is disarmed.
   Sign in with Apple is supported only through the Apple authorization popup
   opened by that Vinted window; direct browsing to Apple remains blocked.

Purchase limits can be edited later under **Buying safety** on the local
control page. Saving replaces only those limit fields in the config file,
applies them to the running policy immediately, and always disarms the agent.

The public release supports only two execution modes:

- `dry_run`: discover and evaluate matching events without making purchases.
- `human_final`: prepare the visible checkout and require the user to perform
  the final payment action.

Start in `dry_run`, then validate real selectors and totals in `human_final`.
`auto_submit` is experimental and development-only; it is not a supported mode
of this public companion release and must not be enabled for normal use, even if
a development build exposes the option.

## Requirements

- Node.js 22 or newer.
- A desktop installation of Google Chrome/Chromium that the user can see and
  interact with. The agent does not bundle a browser.
- `playwright-core@1.55.0` (installed by `npm ci`). It supplies the driver;
  the installed system browser supplies the executable.
- A dedicated absolute user-data directory. Do not point it at a normal
  personal Chrome profile or share it with another automation process.

Supported target is desktop macOS, Windows, or Linux with a visible Chrome or
Chromium window. Mobile browsers, iOS, Android, Safari, Firefox, headless
operation, and remote/cloud browser execution are unsupported.

See [`config.example.json`](config.example.json). The user signs in to Vinted
manually in the visible dedicated window. Authentication cookies and the
saved payment method remain inside that browser profile; this code does not
export cookies, call a storage-state API, read card fields, or store card
numbers. Checkout exposes only a coarse label (`Saved card` or `Vinted
Balance`) and integer totals in the agent state.

The agent does not add Vinted credit. Users without sale balance use whatever
saved payment method Vinted itself offers in the normal checkout. This keeps
funding, card handling, authentication, and any additional verification inside
Vinted; the local agent only verifies the rendered total and, in the supported
`human_final` flow, leaves the final payment action to the user.

## Safety boundaries

- Navigation is restricted to the exact `https://www.vinted.co.uk` origin,
  except for a short-lived Sign in with Apple popup. That exception must begin
  at the exact `https://appleid.apple.com/auth/authorize` endpoint from the
  Vinted window and remains bound to that popup and exact Apple HTTPS origin
  until it returns to Vinted. Lookalike domains, HTTP, ports, credentials,
  other Vinted markets, direct Apple navigation, and unrelated popups are
  rejected.
- Listing identity, explicit availability, live listing price/currency, and
  final checkout total/currency must all be present and match policy before
  a payment control can be considered.
- CAPTCHA, login, Vinted/bank verification, a pending payment, and unknown
  screens are surfaced as states for the user. They are never bypassed.
- The final payment control is clicked at most once per executor instance.
  An uncertain click is `payment_pending`; callers must reconcile the order
  and must not retry.
- The local UI requires a same-origin request and a per-process CSRF token for
  mutations, and binds only to `127.0.0.1`.

## Account, terms, and financial risk

Browser automation may be restricted by Vinted's current Terms of Service,
policies, or anti-abuse systems. Automating an account can result in blocked
requests, verification, purchase cancellation, account limitation, or
suspension. Review Vinted's current terms and use an account only when you
are authorised to automate it. There is no guarantee that a purchase will be
accepted or that a price, seller, shipping option, or payment result will
remain unchanged.

The user is responsible for every purchase, saved-card charge, tax/shipping
amount, return, dispute, and account consequence. Keep auto-submit disabled
until assisted real-world testing has established safe behaviour. Never put
card details, one-time passcodes, CAPTCHA answers, or verification secrets in
configuration, issue reports, logs, or bug tickets.

## Runtime behavior

The agent discovers the account's current searches and an opaque account
fingerprint at startup through Vinotify's versioned integration discovery
endpoint, then refreshes membership every 60 seconds by default
(`vinotify.discoveryRefreshSeconds`). Discovery can see the account scope, but
only IDs in the required `purchase.searchAllowlist` may enter the purchase
queue. At most eight long polls run at once by default
(`vinotify.maxConcurrentFeeds`); the public configuration permits at most 12.
Admission is fair and removed searches are aborted. One serial queue owns the
visible browser. Feed events,
deduplication keys, attempts, state transitions, budget reservations, and
cursors are persisted atomically in a local SQLite database. A crash before
payment can safely requeue work; a crash at or after the payment boundary
becomes `unknown`, holds its budget, blocks later purchases, and can only use
read-only reconciliation. It is never submitted again.

The database is bound to the discovery fingerprint. A token rotation for the
same account can recover work; a different account, or an old database with no
fingerprint, is quarantined and cannot drain. The agent does not delete that
state automatically. To intentionally switch accounts, stop the agent, back up
the SQLite database, and choose a new empty `storage.databasePath` (or move the
old database aside) before starting again. Keep the backup until every
ambiguous payment has been reconciled manually.

SQLite logs and terminal history are pruned in small batches using the
`storage.*Retention*`, `maxLogRows`, and `maxDatabaseBytes` settings. Active,
nonterminal, ambiguous, reserved/held work and live cursors are retained. The
default quota is 512 MiB and includes SQLite's main, WAL, and shared-memory
files; the agent never runs a hot-loop `VACUUM`. If the quota cannot be reduced
without touching live work, ingestion enters a visible degraded state and
payment execution remains fail-closed.

If a discovery refresh fails, the agent keeps the last known search set and
retries; it never replaces a working scope with a guessed or empty one. A fresh
installation remains safely feedless and shows a degraded discovery health
state until the endpoint is available. During a server rollout, a legacy
ID-only discovery response remains completely feedless: no cursors, events,
recovery, queue drain, or execution are started until the fingerprinted
response arrives. The old optional `vinotify.searchIds` setting, if accepted by
a compatibility build, is only a temporary feed bootstrap input; it never
replaces the required `purchase.searchAllowlist` safety boundary.

Expired feed cursors are not silently reset. The affected search stops with an
explicit health error because the retention gap may contain missed listings.
The local UI requires the user to acknowledge that gap before resetting to the
oldest retained event, and disarms the agent during the reset.
Malformed legacy events are skipped and audited without blocking later valid
events.

## Tests

The focused tests use fake Page/Locator objects and a loopback HTTP server;
they do not launch Chrome or access Vinted:

```sh
npm run check
npm test
```

The UI integration test needs permission to bind a local ephemeral port in
some sandboxed environments. The browser tests are entirely in-process.
