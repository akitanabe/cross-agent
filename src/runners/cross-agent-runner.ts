#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commandFor, parseArgs, usage } from "../core/cross-agent/cli.ts";
import type { CommandOutput } from "../core/cross-agent/types.ts";

function writeCommandOutput(result: CommandOutput): void {
  if (result.output_type === "text") {
    const text = String(result.content ?? "");
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.content, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const command = commandFor(args.command);
  if (!command) throw new Error(`Unknown command: ${args.command}`);
  const input = await command.buildInput(args);
  const result = await command.run(input);
  writeCommandOutput(result);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const caught = error as Error;
    process.stderr.write(`${caught.stack ?? caught.message}\n`);
    process.exitCode = 1;
  });
}
