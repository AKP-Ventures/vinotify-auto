import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { EXECUTION_MODES } from "../core/types.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 100;
export const CONTROL_UI_MODES = Object.freeze({
  DRY_RUN: EXECUTION_MODES.DRY_RUN,
  HUMAN_FINAL: EXECUTION_MODES.HUMAN_FINAL,
  AUTO_SUBMIT: EXECUTION_MODES.AUTO_SUBMIT,
});
const MODES = new Set(Object.values(CONTROL_UI_MODES));
const PURCHASE_LIMIT_FIELDS = Object.freeze([
  "maxItemPriceMinor",
  "maxCheckoutTotalMinor",
  "maxDailySpendMinor",
  "maxDailyCount",
  "armDurationSeconds",
]);

export const CONTROL_UI_ROUTES = Object.freeze({
  status: "/api/status",
  settings: "/api/settings",
  mode: "/api/mode",
  arm: "/api/arm",
  disarm: "/api/disarm",
  attempts: "/api/attempts",
  health: "/api/health",
  feeds: "/api/feeds",
});

export const CONTROL_UI_ATTEMPT_ACTIONS = Object.freeze({
  resume: "resume",
  humanSubmitted: "human-submitted",
  reconcile: "reconcile",
});

// Attempt IDs are generated as UUIDs by the durable store. Keep the route
// opaque and bounded: no slashes, controls, or arbitrary path text reach the
// service API.
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAttemptId(value) {
  return typeof value === "string" && ATTEMPT_ID_PATTERN.test(value);
}

function parseAttemptAction(pathname) {
  const match = pathname.match(/^\/api\/attempts\/([^/]+)\/(resume|human-submitted|reconcile)$/);
  if (!match) return null;
  let attemptId;
  try {
    attemptId = decodeURIComponent(match[1]);
  } catch {
    return { invalid: true };
  }
  if (!isValidAttemptId(attemptId)) return { invalid: true };
  return { attemptId, action: match[2] };
}

function parseFeedReset(pathname) {
  const match = pathname.match(/^\/api\/feeds\/(\d+)\/reset-cursor$/);
  if (!match) return null;
  const searchId = Number(match[1]);
  return Number.isSafeInteger(searchId) && searchId > 0 ? { searchId } : { invalid: true };
}

function isValidPurchaseLimitsBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "purchase") return false;
  const purchase = body.purchase;
  if (!purchase || typeof purchase !== "object" || Array.isArray(purchase)) return false;
  const purchaseKeys = Object.keys(purchase);
  if (
    purchaseKeys.length !== PURCHASE_LIMIT_FIELDS.length ||
    PURCHASE_LIMIT_FIELDS.some((field) => !Object.hasOwn(purchase, field))
  ) return false;
  return PURCHASE_LIMIT_FIELDS.every((field) => {
    const value = purchase[field];
    return Number.isSafeInteger(value) && value > 0;
  }) &&
    purchase.maxDailyCount <= 100 &&
    purchase.armDurationSeconds <= 3600 &&
    purchase.maxCheckoutTotalMinor >= purchase.maxItemPriceMinor &&
    purchase.maxDailySpendMinor >= purchase.maxCheckoutTotalMinor;
}

function token() {
  return randomBytes(32).toString("base64url");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isLoopbackAddress(value) {
  const address = String(value ?? "").replace(/^::ffff:/i, "");
  return address === "::1" || (isIP(address) === 4 && address === LOOPBACK_HOST);
}

function jsonHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

function writeJson(response, statusCode, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    statusCode = 500;
    body = JSON.stringify({ error: "response_unavailable" });
  }
  response.writeHead(statusCode, jsonHeaders());
  response.end(body);
}

function writeError(response, statusCode, errorCode) {
  writeJson(response, statusCode, { error: errorCode });
}

function parseContentLength(headers) {
  const value = Number.parseInt(String(headers["content-length"] ?? ""), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readJsonBody(request) {
  const length = parseContentLength(request.headers);
  if (length !== null && length > MAX_BODY_BYTES) {
    const error = new Error("request too large");
    error.code = "REQUEST_TOO_LARGE";
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("request too large");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed;
  } catch {
    const error = new Error("invalid json");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function getServiceMethod(service, method) {
  const candidate = service?.[method];
  return typeof candidate === "function" ? candidate.bind(service) : null;
}

async function invoke(service, method, ...args) {
  const callback = getServiceMethod(service, method);
  if (!callback) {
    const error = new Error(`service method unavailable: ${method}`);
    error.code = "SERVICE_UNAVAILABLE";
    throw error;
  }
  return callback(...args);
}

function currentPort(server, configuredPort) {
  const address = server.address?.();
  return typeof address === "object" && address
    ? address.port
    : configuredPort;
}

function expectedOrigin(server, configuredPort) {
  const port = currentPort(server, configuredPort);
  return Number.isInteger(port) && port > 0
    ? `http://${LOOPBACK_HOST}:${port}`
    : null;
}

function checkRequestBoundary(request, { server, configuredPort, mutation }) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return "loopback_only";
  const origin = expectedOrigin(server, configuredPort);
  if (!origin) return "server_not_started";

  const host = String(request.headers.host ?? "");
  if (host !== `${LOOPBACK_HOST}:${currentPort(server, configuredPort)}`) {
    return "host_not_allowed";
  }

  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) {
    return "origin_not_allowed";
  }
  if (mutation) {
    if (requestOrigin !== origin) return "origin_required";
    if (request.headers["x-csrf-token"] !== request.csrfToken) {
      return "csrf_failed";
    }
  }
  return null;
}

function renderHtml(csrfTokenValue) {
  const nonce = token();
  const safeToken = escapeHtml(csrfTokenValue);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${safeToken}">
    <title>Local control</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: Canvas;
        color: CanvasText;
        --line: color-mix(in srgb, CanvasText 18%, transparent);
        --muted: color-mix(in srgb, CanvasText 68%, Canvas);
        --soft: color-mix(in srgb, CanvasText 5%, Canvas);
        --good: #167054;
        --warn: #945600;
        --danger: #a32828;
      }
      @media (prefers-color-scheme: dark) { :root { --good: #62c9a3; --warn: #edb35d; --danger: #ff8f8f; } }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 18rem; }
      main { width: min(42rem, calc(100% - 2rem)); margin: 0 auto; padding: 2.5rem 0 4rem; }
      header { margin-bottom: 1.75rem; }
      h1 { margin: 0; font-size: clamp(1.75rem, 5vw, 2.35rem); letter-spacing: -.035em; line-height: 1.08; }
      h2 { margin: 0 0 1rem; font-size: 1rem; letter-spacing: -.01em; }
      p { line-height: 1.5; }
      section, details { border-top: 1px solid var(--line); padding: 1.4rem 0; }
      .intro, .muted, .hint { color: var(--muted); }
      .intro { margin: .55rem 0 0; }
      .summary { padding-top: 0; border-top: 0; }
      .summary-title { display: flex; align-items: center; gap: .65rem; margin: 0; font-size: 1.2rem; font-weight: 700; letter-spacing: -.015em; }
      .summary-title::before { content: ""; width: .62rem; height: .62rem; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
      .summary[data-tone="good"] .summary-title { color: var(--good); }
      .summary[data-tone="warn"] .summary-title { color: var(--warn); }
      .summary[data-tone="danger"] .summary-title { color: var(--danger); }
      .summary-detail { margin: .35rem 0 0 1.27rem; color: var(--muted); }
      .notice { margin: 1rem 0 0; padding: .65rem .75rem; border: 1px solid var(--line); border-radius: .45rem; background: var(--soft); }
      .notice[data-error="true"] { color: var(--danger); }
      [hidden] { display: none !important; }
      .actions, .control-row, .arm-row { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
      .control-row { display: grid; grid-template-columns: auto minmax(10rem, 1fr) auto; }
      .arm-row { margin-top: .9rem; }
      .arm-state { margin-right: auto; font-weight: 650; }
      label { font-weight: 650; }
      button, select, input { font: inherit; min-height: 2.55rem; padding: .48rem .78rem; border: 1px solid color-mix(in srgb, CanvasText 38%, transparent); border-radius: .42rem; background: Canvas; color: CanvasText; }
      button { cursor: pointer; font-weight: 620; }
      button:hover:not(:disabled) { background: var(--soft); }
      button:disabled { cursor: not-allowed; opacity: .48; }
      button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 3px solid Highlight; outline-offset: 3px; }
      button[data-action="arm"] { background: CanvasText; color: Canvas; border-color: CanvasText; }
      button[data-action="arm"]:hover:not(:disabled) { background: color-mix(in srgb, CanvasText 84%, Canvas); }
      button[data-action="disarm"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 58%, transparent); }
      .hint { margin: .65rem 0 0; font-size: .92rem; }
      .limits { margin-top: 1.3rem; padding-top: 1.1rem; border-top: 1px solid var(--line); }
      .limits-header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
      .limits-title { margin: 0; font-size: .98rem; }
      .limits-summary { margin: .3rem 0 0; color: var(--muted); line-height: 1.45; }
      .limits-form { margin-top: 1rem; }
      .limits-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem; }
      .limits-grid label { display: grid; gap: .35rem; font-size: .92rem; }
      .limits-grid input { width: 100%; }
      .limits-actions { margin-top: .9rem; }
      .plain-list { list-style: none; margin: 0; padding: 0; }
      .plain-list > li { padding: .75rem 0; border-bottom: 1px solid var(--line); }
      .plain-list > li:first-child { padding-top: 0; }
      .plain-list > li:last-child { padding-bottom: 0; border-bottom: 0; }
      .row-main { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
      .row-title { font-weight: 650; }
      .row-state { color: var(--muted); text-align: right; }
      .row-meta { margin: .25rem 0 0; color: var(--muted); font-size: .92rem; }
      .attempt-actions { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: .65rem; }
      #feed-actions { margin-top: .8rem; }
      details { color: var(--muted); }
      summary { width: fit-content; cursor: pointer; color: CanvasText; font-weight: 650; }
      details[open] summary { margin-bottom: 1rem; }
      dl { display: grid; grid-template-columns: minmax(9rem, 12rem) 1fr; gap: .55rem 1rem; margin: 0; font-size: .92rem; }
      dt { color: var(--muted); }
      dd { margin: 0; color: CanvasText; overflow-wrap: anywhere; }
      ::selection { background: Highlight; color: HighlightText; }
      @media (max-width: 36rem) {
        main { width: min(100% - 1.25rem, 42rem); padding-top: 1.5rem; }
        .control-row { grid-template-columns: 1fr; align-items: stretch; }
        .control-row button, .control-row select { width: 100%; }
        .limits-header { display: block; }
        .limits-header button { margin-top: .7rem; width: 100%; }
        .limits-grid { grid-template-columns: 1fr; }
        .arm-state { width: 100%; margin-bottom: .15rem; }
        .arm-row button { flex: 1 1 8rem; }
        .row-main { display: block; }
        .row-state { display: block; margin-top: .15rem; text-align: left; }
        dl { grid-template-columns: 1fr; gap: .12rem; }
        dd { margin-bottom: .5rem; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Local control</h1>
        <p class="intro">Runs on this device. Starts safely disarmed.</p>
        <p id="message" role="status" aria-live="polite" class="notice" hidden></p>
        <div id="load-actions" class="actions" hidden>
          <button type="button" data-action="retry">Retry</button>
        </div>
      </header>
      <section id="summary" class="summary" data-tone="neutral" aria-labelledby="summary-title">
        <p id="summary-title" class="summary-title">Connecting…</p>
        <p id="summary-detail" class="summary-detail">Checking the local service.</p>
      </section>
      <section aria-labelledby="safety-heading">
        <h2 id="safety-heading">Buying safety</h2>
        <div class="control-row">
          <label for="mode">Mode</label>
          <select id="mode" disabled>
            <option value="dry_run">Dry run</option>
            <option value="human_final">Human final</option>
            <option value="auto_submit">Auto-submit</option>
          </select>
          <button type="button" data-action="set-mode" disabled>Save mode</button>
        </div>
        <div class="arm-row" hidden>
          <span id="arm-state" class="arm-state">Disarmed</span>
          <button type="button" data-action="arm" disabled>Arm</button>
          <button type="button" data-action="disarm" disabled>Disarm</button>
        </div>
        <p id="mode-hint" class="hint">Dry run does not need arming.</p>
        <div class="limits" aria-labelledby="limits-heading">
          <div class="limits-header">
            <div>
              <h3 id="limits-heading" class="limits-title">Purchase limits</h3>
              <p id="limits-summary" class="limits-summary">Loading limits…</p>
            </div>
            <button type="button" data-action="edit-limits" disabled>Edit limits</button>
          </div>
          <form id="limits-form" class="limits-form" hidden novalidate>
            <div class="limits-grid">
              <label for="limit-item-price"><span>Max item price <span data-limit-currency>(£)</span></span>
                <input id="limit-item-price" name="maxItemPrice" type="number" inputmode="decimal" min="0.01" step="0.01" required aria-describedby="limits-hint limits-error">
              </label>
              <label for="limit-checkout-total"><span>Max checkout <span data-limit-currency>(£)</span></span>
                <input id="limit-checkout-total" name="maxCheckoutTotal" type="number" inputmode="decimal" min="0.01" step="0.01" required aria-describedby="limits-hint limits-error">
              </label>
              <label for="limit-daily-spend"><span>Max daily spend <span data-limit-currency>(£)</span></span>
                <input id="limit-daily-spend" name="maxDailySpend" type="number" inputmode="decimal" min="0.01" step="0.01" required aria-describedby="limits-hint limits-error">
              </label>
              <label for="limit-daily-count">Purchases/day
                <input id="limit-daily-count" name="maxDailyCount" type="number" inputmode="numeric" min="1" max="100" step="1" required aria-describedby="limits-hint limits-error">
              </label>
              <label for="limit-arm-duration">Armed duration (minutes)
                <input id="limit-arm-duration" name="armDuration" type="number" inputmode="decimal" min="0.01" max="60" step="0.01" required aria-describedby="limits-hint limits-error">
              </label>
            </div>
            <p id="limits-hint" class="hint">Saving limits disarms the agent.</p>
            <p id="limits-error" class="hint" role="alert" hidden></p>
            <div class="actions limits-actions">
              <button type="submit" data-action="save-limits">Save limits</button>
              <button type="button" data-action="cancel-limits">Cancel</button>
            </div>
          </form>
        </div>
      </section>
      <section id="feeds-section" aria-labelledby="feeds-heading" hidden>
        <h2 id="feeds-heading">Searches needing attention</h2>
        <ul id="feeds" class="plain-list"><li class="muted">Connecting…</li></ul>
        <div id="feed-actions" class="actions"></div>
      </section>
      <section aria-labelledby="attempts-heading">
        <h2 id="attempts-heading">Recent attempts</h2>
        <ul id="attempts" class="plain-list"><li class="muted">None yet</li></ul>
      </section>
      <details>
        <summary>Technical details</summary>
        <dl id="technical"></dl>
      </details>
    </main>
    <script nonce="${nonce}">
      (() => {
        const csrf = document.querySelector('meta[name="csrf-token"]').content;
        const message = document.getElementById('message');
        const retry = document.querySelector('[data-action="retry"]');
        const modeSelect = document.getElementById('mode');
        const saveMode = document.querySelector('[data-action="set-mode"]');
        const armButton = document.querySelector('[data-action="arm"]');
        const disarmButton = document.querySelector('[data-action="disarm"]');
        const armRow = document.querySelector('.arm-row');
        const editLimitsButton = document.querySelector('[data-action="edit-limits"]');
        const limitsForm = document.getElementById('limits-form');
        const limitsError = document.getElementById('limits-error');
        const saveLimitsButton = document.querySelector('[data-action="save-limits"]');
        const cancelLimitsButton = document.querySelector('[data-action="cancel-limits"]');
        const limitInputs = {
          maxItemPrice: document.getElementById('limit-item-price'),
          maxCheckoutTotal: document.getElementById('limit-checkout-total'),
          maxDailySpend: document.getElementById('limit-daily-spend'),
          maxDailyCount: document.getElementById('limit-daily-count'),
          armDuration: document.getElementById('limit-arm-duration'),
        };
        let currentStatus = {};
        let currentSettings = {};
        let currentMode = 'dry_run';
        let limitsEditing = false;
        let limitsSaving = false;
        const text = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);
        const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const showMessage = (value, error = false) => { message.textContent = value; message.dataset.error = error ? 'true' : 'false'; message.hidden = !value; };
        const labelState = (value) => ({
          received: 'Received', validated: 'Checked', queued: 'Queued', listing_checked: 'Listing checked', checkout_opened: 'Checkout open', total_verified: 'Total checked', needs_user_action: 'Needs you', payment_submitted: 'Payment submitted', confirming: 'Confirming', payment_pending: 'Payment pending', succeeded: 'Bought', failed: 'Stopped', skipped: 'Skipped', unknown: 'Needs review'
        })[String(value || '').toLowerCase()] || 'In progress';
        const labelFeedState = (value) => ({ polling: 'Watching', healthy: 'Watching', idle: 'Watching', backing_off: 'Retrying', retrying: 'Retrying', error: 'Retrying', cursor_expired: 'Needs resync', stopped: 'Not connected' })[String(value || '').toLowerCase()] || 'Connecting';
        const formatMoney = (minor, currency) => {
          if (!Number.isFinite(Number(minor))) return null;
          try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: text(currency, 'GBP') }).format(Number(minor) / 100); } catch { return text(currency, 'GBP') + ' ' + (Number(minor) / 100).toFixed(2); }
        };
        const decimalToInteger = (value, multiplier) => {
          const raw = String(value ?? '').trim();
          if (!/^\\d+(?:\\.\\d{1,2})?$/.test(raw)) return null;
          const [whole, fraction = ''] = raw.split('.');
          const denominator = 10 ** fraction.length;
          const numerator = Number(whole) * denominator + Number(fraction || 0);
          const scaled = numerator * multiplier;
          if (!Number.isSafeInteger(scaled) || scaled % denominator !== 0) return null;
          const result = scaled / denominator;
          return Number.isSafeInteger(result) && result > 0 ? result : null;
        };
        const minorInputValue = (minor) => Number.isSafeInteger(minor) && minor > 0 ? (minor / 100).toFixed(2) : '';
        const durationInputValue = (seconds) => {
          if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
          const minutes = seconds / 60;
          return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/0+$/, '').replace(/\\.$/, '');
        };
        const exactDurationSeconds = () => {
          const originalValue = limitInputs.armDuration.dataset.displayValue;
          const originalSeconds = Number(limitInputs.armDuration.dataset.seconds);
          if (
            limitInputs.armDuration.value === originalValue &&
            Number.isSafeInteger(originalSeconds) &&
            originalSeconds > 0
          ) return originalSeconds;
          return decimalToInteger(limitInputs.armDuration.value, 60);
        };
        const durationSummary = (seconds) => {
          if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
          const minutes = seconds / 60;
          const display = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/0+$/, '').replace(/\\.$/, '');
          return display + ' min armed';
        };
        const formatBytes = (bytes) => Number.isFinite(Number(bytes)) ? Math.round(Number(bytes) / (1024 * 1024)) + ' MB' : '—';
        const relativeTime = (value) => {
          const date = new Date(value);
          const delta = Date.now() - date.getTime();
          if (!Number.isFinite(delta)) return null;
          if (delta < 60_000) return 'just now';
          if (delta < 3_600_000) return Math.floor(delta / 60_000) + ' min ago';
          if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + ' hr ago';
          return Math.floor(delta / 86_400_000) + ' d ago';
        };
        const addDetail = (target, label, value) => {
          const dt = document.createElement('dt');
          const dd = document.createElement('dd');
          dt.textContent = label;
          dd.textContent = text(value);
          target.append(dt, dd);
        };
        const REQUEST_TIMEOUT_MS = 8000;
        const requestJson = async (path, options) => {
          let signal;
          let timeoutId = null;
          if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
          } else if (typeof AbortController !== 'undefined') {
            const controller = new AbortController();
            signal = controller.signal;
            timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          }
          try {
            const response = await fetch(path, signal ? { ...options, signal } : options);
            const payload = await response.json();
            if (!response.ok) {
              const error = new Error(payload && payload.error ? String(payload.error) : 'request_failed');
              error.code = payload && payload.error ? String(payload.error) : 'request_failed';
              throw error;
            }
            return payload;
          } finally {
            if (timeoutId !== null) window.clearTimeout(timeoutId);
          }
        };
        const get = (path) => requestJson(path, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
        const post = (path, body = {}) => requestJson(path, { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
        const attemptId = (item) => item && typeof item.attemptId === 'string' ? item.attemptId : null;
        const actionButton = (label, onClick) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', onClick); return button; };
        const attemptAction = async (item, action, label, body = {}, confirmText = null) => {
          const id = attemptId(item);
          if (!id) return;
          if (confirmText && !window.confirm(confirmText)) return;
          try { await post('/api/attempts/' + encodeURIComponent(id) + '/' + action, body); await load(); showMessage(label + ' complete.'); } catch { showMessage(label + ' failed.', true); }
        };
        const renderAttempt = (item) => {
          const li = document.createElement('li');
          if (!item || typeof item !== 'object') { li.textContent = text(item, 'Unknown attempt'); return li; }
          const main = document.createElement('div'); main.className = 'row-main';
          const title = document.createElement('span'); title.className = 'row-title';
          title.textContent = item.itemId ? 'Item ' + item.itemId : 'Purchase attempt';
          if (item.searchId) title.textContent += ' · Search ' + item.searchId;
          const stateLabel = document.createElement('span'); stateLabel.className = 'row-state'; stateLabel.textContent = labelState(item.state || item.status);
          main.append(title, stateLabel);
          li.append(main);
          const metaParts = [];
          const money = formatMoney(item.finalTotalMinor ?? item.itemPriceMinor, item.currency);
          if (money) metaParts.push(money);
          const when = relativeTime(item.updatedAt || item.createdAt);
          if (when) metaParts.push(when);
          if (metaParts.length) { const meta = document.createElement('p'); meta.className = 'row-meta'; meta.textContent = metaParts.join(' · '); li.append(meta); }
          if (!attemptId(item)) return li;
          const actions = document.createElement('div'); actions.className = 'attempt-actions';
          const state = String(item.state || item.status || '').toLowerCase();
          const reason = String(item.reason || '').toLowerCase();
          if (state === 'needs_user_action' && reason !== 'human_final_required') actions.append(actionButton('Resume', () => attemptAction(item, 'resume', 'Resume')));
          if (reason === 'human_final_required') actions.append(actionButton('Mark submitted', () => attemptAction(item, 'human-submitted', 'Human submission', { confirmed: true }, "Confirm that you pressed Vinted's final payment button for this attempt. Continue?")));
          if (['payment_submitted', 'confirming', 'payment_pending', 'unknown'].includes(state)) actions.append(actionButton('Reconcile', () => attemptAction(item, 'reconcile', 'Reconciliation')));
          if (actions.childNodes.length) li.append(actions);
          return li;
        };
        const renderFeeds = (health) => {
          const list = document.getElementById('feeds');
          const target = document.getElementById('feed-actions');
          list.replaceChildren();
          target.replaceChildren();
          const feeds = health && health.feeds && typeof health.feeds === 'object' ? health.feeds : {};
          const entries = Object.entries(feeds).filter(([, feed]) => !['polling', 'healthy', 'idle'].includes(String(asObject(feed).state || '').toLowerCase()));
          document.getElementById('feeds-section').hidden = entries.length === 0;
          for (const [searchId, feed] of entries) {
            const details = asObject(feed);
            const li = document.createElement('li');
            const main = document.createElement('div'); main.className = 'row-main';
            const title = document.createElement('span'); title.className = 'row-title'; title.textContent = 'Search ' + searchId;
            const state = document.createElement('span'); state.className = 'row-state'; state.textContent = labelFeedState(details.state);
            main.append(title, state); li.append(main);
            const updated = relativeTime(details.lastSuccessAt);
            if (updated) { const meta = document.createElement('p'); meta.className = 'row-meta'; meta.textContent = 'Updated ' + updated; li.append(meta); }
            list.append(li);
            if (details.state !== 'cursor_expired') continue;
            target.append(actionButton('Reset search ' + searchId, async () => {
              if (!window.confirm('This feed cursor expired. Some events may have been missed. Reset to the oldest retained event and keep the agent disarmed?')) return;
              try { await post('/api/feeds/' + encodeURIComponent(searchId) + '/reset-cursor', { confirmed: true }); await load(); showMessage('Search reset. Review it before arming.'); } catch { showMessage('Search reset failed.', true); }
            }));
          }
        };
        const renderSummary = (status, health, selectedMode) => {
          const summary = document.getElementById('summary');
          const title = document.getElementById('summary-title');
          const detail = document.getElementById('summary-detail');
          const feeds = Object.values(asObject(health.feeds));
          const unhealthy = feeds.filter((feed) => !['polling', 'healthy', 'idle'].includes(String(asObject(feed).state || '').toLowerCase())).length;
          const needsAttention = Boolean(status.degraded || status.fatal || health.ok === false || unhealthy);
          if (needsAttention) { title.textContent = 'Needs attention'; summary.dataset.tone = 'danger'; }
          else if (selectedMode === 'dry_run') { title.textContent = 'Dry run — no purchases will be made'; summary.dataset.tone = 'good'; }
          else if (status.armed) { title.textContent = 'Armed — buying is enabled'; summary.dataset.tone = 'warn'; }
          else { title.textContent = 'Watching safely — disarmed'; summary.dataset.tone = 'good'; }
          const count = feeds.length || Number(asObject(status.discovery).searchCount) || 0;
          detail.textContent = unhealthy ? unhealthy + (unhealthy === 1 ? ' search needs attention' : ' searches need attention') : count ? count + (count === 1 ? ' search connected' : ' searches connected') : 'No searches connected';
        };
        const renderControls = (status, settings, selectedMode) => {
          const purchase = asObject(settings.purchase);
          const autoEnabled = purchase.enableAutoSubmit === true;
          const autoOption = modeSelect.querySelector('option[value="auto_submit"]');
          if (autoOption) autoOption.disabled = !autoEnabled && selectedMode !== 'auto_submit';
          modeSelect.value = selectedMode;
          modeSelect.disabled = false;
          currentMode = selectedMode;
          const armed = status.armed === true;
          const armedUntil = armed && status.armedUntil ? new Date(status.armedUntil) : null;
          document.getElementById('arm-state').textContent = armed ? 'Armed' + (armedUntil && !Number.isNaN(armedUntil.getTime()) ? ' until ' + armedUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') : 'Disarmed';
          disarmButton.disabled = !armed;
          updateControlAvailability();
        };
        const updateControlAvailability = () => {
          const purchase = asObject(currentSettings.purchase);
          const selected = modeSelect.value;
          const autoDisabled = selected === 'auto_submit' && purchase.enableAutoSubmit !== true;
          const dryRun = selected === 'dry_run';
          armRow.hidden = dryRun;
          modeSelect.disabled = limitsSaving;
          saveMode.disabled = limitsSaving || selected === currentMode || autoDisabled;
          armButton.disabled = limitsSaving || currentStatus.armed === true || dryRun || autoDisabled || selected !== currentMode;
          const hint = document.getElementById('mode-hint');
          if (autoDisabled) hint.textContent = 'Auto-submit is disabled in the local configuration.';
          else if (selected !== currentMode) hint.textContent = 'Save this mode before arming.';
          else if (dryRun) hint.textContent = 'Dry run does not need arming.';
          else if (selected === 'human_final') hint.textContent = 'Arm when ready. You make the final payment.';
          else hint.textContent = 'Arming temporarily enables automatic purchasing.';
        };
        const updateLimitsControls = () => {
          editLimitsButton.hidden = limitsEditing;
          editLimitsButton.disabled = limitsSaving;
          limitsForm.hidden = !limitsEditing;
          saveLimitsButton.disabled = limitsSaving;
          cancelLimitsButton.disabled = limitsSaving;
          updateControlAvailability();
        };
        const populateLimitForm = (purchase) => {
          limitInputs.maxItemPrice.value = minorInputValue(purchase.maxItemPriceMinor);
          limitInputs.maxCheckoutTotal.value = minorInputValue(purchase.maxCheckoutTotalMinor);
          limitInputs.maxDailySpend.value = minorInputValue(purchase.maxDailySpendMinor);
          limitInputs.maxDailyCount.value = Number.isSafeInteger(purchase.maxDailyCount) && purchase.maxDailyCount > 0 ? String(purchase.maxDailyCount) : '';
          const durationValue = durationInputValue(purchase.armDurationSeconds);
          limitInputs.armDuration.value = durationValue;
          limitInputs.armDuration.dataset.displayValue = durationValue;
          limitInputs.armDuration.dataset.seconds = Number.isSafeInteger(purchase.armDurationSeconds) ? String(purchase.armDurationSeconds) : '';
        };
        const renderLimits = (settings) => {
          const purchase = asObject(settings.purchase);
          const currencies = Array.isArray(purchase.currencyAllowlist) ? purchase.currencyAllowlist.filter(Boolean) : [];
          const currency = currencies[0] || 'GBP';
          const currencyLabel = currencies.length > 1 ? currencies.join('/') : currency === 'GBP' ? '£' : currency;
          for (const label of document.querySelectorAll('[data-limit-currency]')) label.textContent = '(' + currencyLabel + ')';
          const parts = [
            Number.isSafeInteger(purchase.maxItemPriceMinor) ? formatMoney(purchase.maxItemPriceMinor, currency) + ' item' : null,
            Number.isSafeInteger(purchase.maxCheckoutTotalMinor) ? formatMoney(purchase.maxCheckoutTotalMinor, currency) + ' checkout' : null,
            Number.isSafeInteger(purchase.maxDailySpendMinor) ? formatMoney(purchase.maxDailySpendMinor, currency) + ' per day' : null,
            Number.isSafeInteger(purchase.maxDailyCount) ? purchase.maxDailyCount + (purchase.maxDailyCount === 1 ? ' purchase/day' : ' purchases/day') : null,
            durationSummary(purchase.armDurationSeconds),
          ].filter(Boolean);
          document.getElementById('limits-summary').textContent = parts.length ? parts.join(' · ') : 'Limits unavailable';
          if (!limitsEditing) populateLimitForm(purchase);
          updateLimitsControls();
        };
        const readLimitForm = () => {
          const purchase = {
            maxItemPriceMinor: decimalToInteger(limitInputs.maxItemPrice.value, 100),
            maxCheckoutTotalMinor: decimalToInteger(limitInputs.maxCheckoutTotal.value, 100),
            maxDailySpendMinor: decimalToInteger(limitInputs.maxDailySpend.value, 100),
            maxDailyCount: /^\\d+$/.test(limitInputs.maxDailyCount.value.trim()) ? Number(limitInputs.maxDailyCount.value) : null,
            armDurationSeconds: exactDurationSeconds(),
          };
          for (const input of Object.values(limitInputs)) input.removeAttribute('aria-invalid');
          limitsError.hidden = true;
          limitsError.textContent = '';
          if (
            !Number.isSafeInteger(purchase.maxItemPriceMinor) || purchase.maxItemPriceMinor <= 0 ||
            !Number.isSafeInteger(purchase.maxCheckoutTotalMinor) || purchase.maxCheckoutTotalMinor <= 0 ||
            !Number.isSafeInteger(purchase.maxDailySpendMinor) || purchase.maxDailySpendMinor <= 0 ||
            !Number.isSafeInteger(purchase.maxDailyCount) || purchase.maxDailyCount <= 0 || purchase.maxDailyCount > 100 ||
            !Number.isSafeInteger(purchase.armDurationSeconds) || purchase.armDurationSeconds <= 0 || purchase.armDurationSeconds > 3600
          ) {
            for (const input of Object.values(limitInputs)) input.setAttribute('aria-invalid', 'true');
            return { error: 'Enter valid positive limits. Prices use pounds and pence; counts and duration use numbers.' };
          }
          if (purchase.maxCheckoutTotalMinor < purchase.maxItemPriceMinor) {
            limitInputs.maxCheckoutTotal.setAttribute('aria-invalid', 'true');
            return { error: 'Max checkout must be at least max item price.' };
          }
          if (purchase.maxDailySpendMinor < purchase.maxCheckoutTotalMinor) {
            limitInputs.maxDailySpend.setAttribute('aria-invalid', 'true');
            return { error: 'Max daily spend must be at least max checkout.' };
          }
          return { purchase };
        };
        const renderTechnical = (status, settings, health) => {
          const target = document.getElementById('technical'); target.replaceChildren();
          const vinotify = asObject(settings.vinotify); const browser = asObject(settings.browser); const purchase = asObject(settings.purchase); const storage = asObject(settings.storage);
          addDetail(target, 'Service', vinotify.baseUrl);
          addDetail(target, 'Search scope', vinotify.searchScope === 'all account searches' ? 'All account searches' : vinotify.searchScope);
          addDetail(target, 'Polling', Number.isFinite(Number(vinotify.longPollSeconds)) ? vinotify.longPollSeconds + ' seconds' : null);
          addDetail(target, 'Connected searches', Number(asObject(status.discovery).searchCount) || Object.keys(asObject(status.feeds)).length || null);
          addDetail(target, 'Browser', [browser.market, browser.profile].filter(Boolean).join(' · '));
          addDetail(target, 'Auto-submit', purchase.enableAutoSubmit ? 'Enabled' : 'Disabled');
          addDetail(target, 'Allowed markets', Array.isArray(purchase.marketAllowlist) ? purchase.marketAllowlist.join(', ') : null);
          addDetail(target, 'Allowed currencies', Array.isArray(purchase.currencyAllowlist) ? purchase.currencyAllowlist.join(', ') : null);
          const currency = Array.isArray(purchase.currencyAllowlist) && purchase.currencyAllowlist[0] ? purchase.currencyAllowlist[0] : 'GBP';
          const limits = [
            [purchase.maxItemPriceMinor, ' per item'],
            [purchase.maxCheckoutTotalMinor, ' checkout'],
            [purchase.maxDailySpendMinor, ' per day'],
          ].map(([minor, suffix]) => { const value = formatMoney(minor, currency); return value ? value + suffix : null; }).filter(Boolean);
          if (Number.isFinite(Number(purchase.maxDailyCount))) limits.push(purchase.maxDailyCount + (Number(purchase.maxDailyCount) === 1 ? ' purchase per day' : ' purchases per day'));
          addDetail(target, 'Purchase limits', limits.join(' · '));
          const storageState = text(asObject(status.storage).state, health.database);
          addDetail(target, 'Storage', (storageState === 'ok' ? 'Healthy' : storageState) + ' · ' + formatBytes(storage.maxDatabaseBytes || asObject(status.storage).maxDatabaseBytes));
          addDetail(target, 'History', [storage.attemptRetentionDays && 'Attempts ' + storage.attemptRetentionDays + ' days', storage.logRetentionDays && 'Logs ' + storage.logRetentionDays + ' days'].filter(Boolean).join(' · '));
        };
        let loading = false;
        const load = async () => {
          if (loading) return;
          loading = true;
          retry.disabled = true;
          retry.parentElement.hidden = true;
          showMessage('Loading…');
          try {
            const [status, settings, mode, attempts, health] = await Promise.all([get('/api/status'), get('/api/settings'), get('/api/mode'), get('/api/attempts'), get('/api/health')]);
            const selected = typeof mode === 'string' ? mode : mode && mode.mode;
            currentStatus = asObject(status); currentSettings = asObject(settings);
            renderSummary(currentStatus, asObject(health), selected || currentStatus.mode || 'dry_run');
            renderControls(currentStatus, currentSettings, selected || currentStatus.mode || 'dry_run');
            renderLimits(currentSettings);
            renderFeeds(asObject(health));
            renderTechnical(currentStatus, currentSettings, asObject(health));
            const list = document.getElementById('attempts');
            list.replaceChildren();
            const items = Array.isArray(attempts) ? attempts : attempts && Array.isArray(attempts.attempts) ? attempts.attempts : [];
            if (!items.length) {
              const li = document.createElement('li');
              li.className = 'muted';
              li.textContent = 'None yet';
              list.append(li);
            } else {
              for (const item of items) list.append(renderAttempt(item));
            }
            showMessage('');
          } catch {
            document.getElementById('summary-title').textContent = 'Not connected';
            document.getElementById('summary-detail').textContent = 'Start the local agent, then retry.';
            document.getElementById('summary').dataset.tone = 'danger';
            showMessage('The local service is unavailable.', true);
            retry.parentElement.hidden = false;
          } finally {
            loading = false;
            retry.disabled = false;
          }
        };
        retry.addEventListener('click', load);
        modeSelect.addEventListener('change', updateControlAvailability);
        saveMode.addEventListener('click', async () => { try { await post('/api/mode', { mode: modeSelect.value }); await load(); showMessage('Mode saved.'); } catch { showMessage('Mode could not be saved.', true); } });
        armButton.addEventListener('click', async () => { try { await post('/api/arm'); await load(); showMessage('Armed.'); } catch { showMessage('Could not arm buying.', true); } });
        disarmButton.addEventListener('click', async () => { try { await post('/api/disarm'); await load(); showMessage('Disarmed.'); } catch { showMessage('Could not disarm buying.', true); } });
        editLimitsButton.addEventListener('click', () => {
          if (limitsSaving) return;
          limitsEditing = true;
          populateLimitForm(asObject(currentSettings.purchase));
          showMessage('');
          limitsError.hidden = true;
          limitsError.textContent = '';
          updateLimitsControls();
          limitInputs.maxItemPrice.focus();
        });
        cancelLimitsButton.addEventListener('click', () => {
          if (limitsSaving) return;
          limitsEditing = false;
          populateLimitForm(asObject(currentSettings.purchase));
          showMessage('');
          limitsError.hidden = true;
          limitsError.textContent = '';
          updateLimitsControls();
        });
        limitsForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (limitsSaving) return;
          const parsed = readLimitForm();
          if (parsed.error) {
            limitsError.textContent = parsed.error;
            limitsError.hidden = false;
            limitsForm.querySelector('[aria-invalid="true"]')?.focus();
            return;
          }
          limitsSaving = true;
          updateLimitsControls();
          showMessage('Saving limits…');
          try {
            await post('/api/settings', parsed);
            limitsEditing = false;
            await load();
            showMessage('Limits saved. Agent disarmed.');
          } catch (error) {
            if (error?.code === 'invalid_purchase_limits') {
              limitsError.textContent = 'Limits were rejected. Check all five values and try again.';
              limitsError.hidden = false;
            } else if (error?.code === 'limits_save_failed_disarmed') {
              await load();
              showMessage('Limits were not saved. Agent disarmed.', true);
            } else {
              showMessage('Limits could not be saved. Check the local service and try again.', true);
            }
          } finally {
            limitsSaving = false;
            updateLimitsControls();
          }
        });
        load();
      })();
    </script>
  </body>
</html>`;
}

function writeHtml(response, body) {
  // The nonce is generated inside renderHtml and extracted only from the
  // script element.  No service data is inserted into the document.
  const nonce = body.match(/<script nonce="([A-Za-z0-9_-]+)">/)?.[1];
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce ?? "invalid"}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  };
  response.writeHead(200, headers);
  response.end(body);
}

/**
 * Construct the local control server.  It does not start listening until
 * start() is called, making integration with the final app entry explicit.
 */
export function createControlUi({ service, host = LOOPBACK_HOST, port = 0 } = {}) {
  if (host !== LOOPBACK_HOST) {
    throw new TypeError("Control UI must bind to 127.0.0.1");
  }
  if (!service || typeof service !== "object") {
    throw new TypeError("Control UI requires an injected service API");
  }
  const csrfTokenValue = token();
  const server = createServer(async (request, response) => {
    const mutation = request.method === "POST";
    request.csrfToken = csrfTokenValue;
    const boundaryError = checkRequestBoundary(request, {
      server,
      configuredPort: port,
      mutation,
    });
    if (boundaryError) {
      writeError(response, 403, boundaryError);
      return;
    }

    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`).pathname;
    const attemptRoute = parseAttemptAction(pathname);
    const feedResetRoute = parseFeedReset(pathname);
    if (method === "GET" && pathname === "/") {
      writeHtml(response, renderHtml(csrfTokenValue));
      return;
    }
    if (attemptRoute?.invalid) {
      writeError(response, 422, "invalid_attempt_id");
      return;
    }
    if (feedResetRoute?.invalid) {
      writeError(response, 422, "invalid_search_id");
      return;
    }
    if (!["GET", "POST"].includes(method)) {
      writeError(response, 405, "method_not_allowed");
      return;
    }

    try {
      if (method === "POST" && feedResetRoute) {
        const body = await readJsonBody(request);
        if (body.confirmed !== true) {
          writeError(response, 422, "feed_gap_confirmation_required");
          return;
        }
        writeJson(response, 200, await invoke(service, "resetFeedCursor", {
          searchId: feedResetRoute.searchId,
        }));
      } else if (method === "POST" && attemptRoute) {
        if (attemptRoute.action === CONTROL_UI_ATTEMPT_ACTIONS.humanSubmitted) {
          const body = await readJsonBody(request);
          if (body.confirmed !== true) {
            writeError(response, 422, "human_submission_confirmation_required");
            return;
          }
          writeJson(response, 200, await invoke(service, "recordHumanSubmitted", {
            attemptId: attemptRoute.attemptId,
          }));
        } else if (attemptRoute.action === CONTROL_UI_ATTEMPT_ACTIONS.resume) {
          writeJson(response, 200, await invoke(service, "resumeAttempt", {
            attemptId: attemptRoute.attemptId,
          }));
        } else if (attemptRoute.action === CONTROL_UI_ATTEMPT_ACTIONS.reconcile) {
          writeJson(response, 200, await invoke(service, "reconcileAttempt", {
            attemptId: attemptRoute.attemptId,
          }));
        } else {
          writeError(response, 404, "not_found");
        }
      } else if (method === "GET" && pathname === CONTROL_UI_ROUTES.status) {
        writeJson(response, 200, await invoke(service, "status"));
      } else if (method === "GET" && pathname === CONTROL_UI_ROUTES.settings) {
        writeJson(response, 200, await invoke(service, "settings"));
      } else if (method === "GET" && pathname === CONTROL_UI_ROUTES.mode) {
        writeJson(response, 200, await invoke(service, "mode"));
      } else if (method === "POST" && pathname === CONTROL_UI_ROUTES.settings) {
        const body = await readJsonBody(request);
        if (!isValidPurchaseLimitsBody(body)) {
          writeError(response, 422, "invalid_purchase_limits");
          return;
        }
        writeJson(response, 200, await invoke(service, "updatePurchaseLimits", body.purchase));
      } else if (method === "GET" && pathname === CONTROL_UI_ROUTES.attempts) {
        const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
        const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        const limit = Number.isSafeInteger(parsedLimit)
          ? Math.min(Math.max(parsedLimit, 1), MAX_ATTEMPTS)
          : 20;
        writeJson(response, 200, await invoke(service, "recentAttempts", { limit }));
      } else if (method === "GET" && pathname === CONTROL_UI_ROUTES.health) {
        writeJson(response, 200, await invoke(service, "health"));
      } else if (method === "POST" && pathname === CONTROL_UI_ROUTES.mode) {
        const body = await readJsonBody(request);
        if (!MODES.has(body.mode)) {
          writeError(response, 422, "invalid_mode");
          return;
        }
        writeJson(response, 200, await invoke(service, "setMode", { mode: body.mode }));
      } else if (method === "POST" && pathname === CONTROL_UI_ROUTES.arm) {
        const body = await readJsonBody(request);
        const ttlSeconds = body.ttlSeconds === undefined ? undefined : Number(body.ttlSeconds);
        if (
          ttlSeconds !== undefined &&
          (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600)
        ) {
          writeError(response, 422, "invalid_arm_duration");
          return;
        }
        writeJson(response, 200, await invoke(service, "arm", { ttlSeconds }));
      } else if (method === "POST" && pathname === CONTROL_UI_ROUTES.disarm) {
        if (request.headers["content-length"] && Number(request.headers["content-length"]) > 0) {
          // A disarm call has no body; accepting one would make request
          // smuggling/debugging harder without adding functionality.
          await readJsonBody(request);
        }
        writeJson(response, 200, await invoke(service, "disarm"));
      } else {
        writeError(response, 404, "not_found");
      }
    } catch (error) {
      if (error?.code === "REQUEST_TOO_LARGE") writeError(response, 413, "request_too_large");
      else if (error?.code === "INVALID_JSON") writeError(response, 400, "invalid_json");
      else if (error?.code === "LIMITS_SAVE_FAILED_DISARMED") writeError(response, 503, "limits_save_failed_disarmed");
      else if (error?.code === "LIMITS_UPDATE_IN_PROGRESS") writeError(response, 409, "limits_update_in_progress");
      else writeError(response, 503, "service_unavailable");
    }
  });

  return {
    server,
    csrfToken: csrfTokenValue,
    get origin() {
      return expectedOrigin(server, port);
    },
    async start() {
      if (server.listening) return { origin: expectedOrigin(server, port) };
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolvePromise();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return { origin: expectedOrigin(server, port) };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
  };
}
