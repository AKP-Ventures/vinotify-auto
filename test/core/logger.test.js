import assert from "node:assert/strict";
import test from "node:test";
import { RedactedLogger, redact } from "../../src/core/logger.js";

test("structured logger redacts auth, payment and secret fields", () => {
  const lines = [];
  const logger = new RedactedLogger({ sink: (line) => lines.push(line), clock: () => new Date("2026-01-01T00:00:00Z") });
  const record = logger.info("checkout", {
    authorization: "Bearer super-secret",
    cardNumber: "4111111111111111",
    nested: { webhook_url: "https://example.test?secret=abc", title: "Visible" },
  });
  assert.equal(record.authorization, "[REDACTED]");
  assert.equal(record.cardNumber, "[REDACTED]");
  assert.equal(record.nested.webhook_url, "https://example.test?secret=[REDACTED]");
  assert.equal(record.nested.title, "Visible");
  assert.equal(JSON.parse(lines[0]).cardNumber, "[REDACTED]");
  assert.equal(redact({ password: "x", safe: "y" }).password, "[REDACTED]");
});
