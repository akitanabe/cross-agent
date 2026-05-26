#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, usage } from "../core/claude-adapter/cli.ts";
import { ClaudePrepareFailedError } from "../core/claude-adapter/workflow-failure.ts";
import { completeClaudeRun, prepareClaudeRun } from "../core/claude-adapter/workflow.ts";

async function readRequest(requestFile: string): Promise<unknown> {
  return JSON.parse(await readFile(requestFile, "utf8"));
}

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
    const request = await readRequest(args.requestFile);
    try {
      const result = await prepareClaudeRun(request as never, { dataDir: args.dataDir });
      process.stdout.write(`${result.path}\n`);
    } catch (error) {
      if (!(error instanceof ClaudePrepareFailedError)) throw error;
      process.stderr.write(`${error.name}: ${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "complete") {
    if (!args.requestFile) throw new Error("--request is required.");
    if (!args.outputFile) throw new Error("--output-file is required.");
    const request = await readRequest(args.requestFile);
    const result = await completeClaudeRun(request as never, args.outputFile, { dataDir: args.dataDir });
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
