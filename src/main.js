#!/usr/bin/env node

import { loadConfig, publicConfig } from "./config.js";

function argumentsFrom(argv) {
  const result = { config: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") result.config = argv[++index] ?? null;
    else if (value === "--check-config") result.check = true;
    else if (value === "--help" || value === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function usage() {
  return "Usage: npm start -- --config /absolute/path/to/config.json [--check-config]";
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.config) throw new Error(usage());
  const config = await loadConfig(args.config);
  if (args.check) {
    process.stdout.write(`${JSON.stringify(publicConfig(config), null, 2)}\n`);
    return;
  }

  const { createAgentApp } = await import("./app.js");
  const app = await createAgentApp(config);
  const { origin } = await app.start();
  process.stdout.write(`Local control: ${origin}\n`);
  process.stdout.write("Use the visible Vinted window to sign in. The agent starts disarmed.\n");

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      await app.stop(`signal_${signal}`);
    } finally {
      process.exitCode = 0;
    }
  };
  process.once("SIGINT", () => { void stop("SIGINT"); });
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
}

main().catch((error) => {
  process.stderr.write(`Local agent failed: ${error.message}\n`);
  process.exitCode = 1;
});
