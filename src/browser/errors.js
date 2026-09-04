export class BrowserAutomationError extends Error {
  constructor(message, { code = "BROWSER_UNKNOWN", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BrowserAutomationError";
    this.code = code;
  }
}
