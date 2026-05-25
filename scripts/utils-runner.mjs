#!/usr/bin/env node

// src/runners/utils-runner.ts
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/shared/path-utils.ts
function normalizePath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (platform !== "win32") return value;
  let normalized = value.replace(/\\/g, "/");
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(normalized);
  if (msys) normalized = `${msys[1].toUpperCase()}:${normalized.slice(2)}`;
  return normalized;
}

// src/runners/utils-runner.ts
function parseArgs(argv) {
  return { command: argv[0], positional: argv.slice(1), help: argv.includes("--help") || argv.includes("-h") };
}
function usage() {
  return `Usage:
  node scripts/utils-runner.mjs normalize-path <path...>`;
}
function runNormalizePathCommand(positional) {
  if (positional.length === 0) throw new Error("normalize-path requires at least one path argument.");
  return positional.map((value) => normalizePath(value));
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${usage()}
`);
    return;
  }
  if (args.command === "normalize-path") {
    process.stdout.write(`${runNormalizePathCommand(args.positional).join("\n")}
`);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}
var invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}
`);
    process.exitCode = 1;
  });
}
export {
  runNormalizePathCommand
};
