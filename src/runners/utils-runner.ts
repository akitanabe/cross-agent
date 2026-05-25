#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePath } from "../core/shared/path-utils.ts";

function parseArgs(argv: string[]) {
  return { command: argv[0], positional: argv.slice(1), help: argv.includes("--help") || argv.includes("-h") };
}

function usage() {
  return `Usage:
  node scripts/utils-runner.mjs normalize-path <path...>`;
}

export function runNormalizePathCommand(positional: string[]) {
  if (positional.length === 0) throw new Error("normalize-path requires at least one path argument.");
  return positional.map((value) => normalizePath(value));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (args.command === "normalize-path") {
    process.stdout.write(`${runNormalizePathCommand(args.positional).join("\n")}\n`);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
