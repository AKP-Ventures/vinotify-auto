const SENSITIVE_KEY = /(?:authorization|access.?token|refresh.?token|api.?key|secret|password|passphrase|cookie|session|card|cvv|cvc|otp|one.?time|private.?key)/i;
const BEARER = /\bBearer\s+[^\s,]+/gi;
const QUERY_SECRET = /([?&](?:token|secret|key|password|authorization|webhook_url)=)[^&#\s]*/gi;
const MAX_STRING_LENGTH = 2_000;

function redactString(value) {
  return String(value)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(QUERY_SECRET, "$1[REDACTED]")
    .slice(0, MAX_STRING_LENGTH);
}

export function redact(value, key = "", seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : "[BIGINT]";
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, "", seen));
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redact(childValue, childKey, seen);
  }
  return output;
}

/**
 * Structured logger that writes only redacted JSON lines to the supplied sink.
 * The default sink is intentionally local stdout; callers may provide a file
 * sink without changing the core.
 */
export class RedactedLogger {
  constructor({ sink = (line) => process.stdout.write(`${line}\n`), clock = () => new Date(), store = null } = {}) {
    this.sink = sink;
    this.clock = clock;
    this.store = store;
  }

  log(level, event, fields = {}) {
    const record = redact({
      ts: this.clock().toISOString(),
      level,
      event,
      ...fields,
    });
    this.sink(JSON.stringify(record));
    this.store?.appendLog(record);
    return record;
  }

  debug(event, fields) {
    return this.log("debug", event, fields);
  }

  info(event, fields) {
    return this.log("info", event, fields);
  }

  warn(event, fields) {
    return this.log("warn", event, fields);
  }

  error(event, fields) {
    return this.log("error", event, fields);
  }
}
