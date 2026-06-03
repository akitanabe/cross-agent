#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, usage } from "../core/codex-adapter/cli.ts";
import { completeCodexRun, prepareCodexRun } from "../core/codex-adapter/workflow.ts";
import { CodexPrepareFailedError } from "../core/codex-adapter/workflow-failure.ts";

// CLI entrypoint。prepare / complete の結果 file path だけを stdout に出す。
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (!args.command) throw new Error("command is required. Use prepare or complete.");
  if (!args.dataDir) throw new Error("--data-dir is required.");

  if (args.command === "prepare") {
    if (!args.requestFile) throw new Error("--request is required.");
    const input = await readFile(args.requestFile, "utf8");
    const request = JSON.parse(input);
    try {
      const result = await prepareCodexRun(request, { dataDir: args.dataDir });
      process.stdout.write(`${result.path}\n`);
    } catch (error) {
      if (!(error instanceof CodexPrepareFailedError)) throw error;
      process.stderr.write(`${error.name}: ${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "complete") {
    if (!args.runFile) throw new Error("--run is required.");
    const result = await completeCodexRun(args.runFile, { dataDir: args.dataDir });
    process.stdout.write(`${result.path}\n`);
    process.exitCode = result.response.status === "completed" ? 0 : 1;
    return;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const caught = error as Error;
    process.stderr.write(`${caught.stack ?? caught.message}\n`);
    process.exitCode = 1;
  });
}
