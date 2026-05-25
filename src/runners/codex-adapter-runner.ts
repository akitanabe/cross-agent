#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, usage } from "../core/codex-adapter/cli.ts";
import { artifactDirFor, artifactPaths } from "../core/codex-adapter/state.ts";
import { runAdapter } from "../core/codex-adapter/workflow.ts";
import { normalizePath } from "../core/shared/path-utils.ts";

// CLI entrypoint。request file を読み込み runner を実行して response file path を stdout に出す。
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (!args.requestFile) throw new Error("--request is required.");
  if (!args.dataDir) throw new Error("--data-dir is required.");

  const input = await readFile(args.requestFile, "utf8");
  const request = JSON.parse(input);
  const response = await runAdapter(request, {
    codexBin: args.codexBin,
    dataDir: args.dataDir,
    launcher: args.launcher,
  });
  const responseFile = normalizePath(
    artifactPaths(artifactDirFor(args.dataDir, request.review_session_id ?? "unknown"), request.round ?? "unknown")
      .responseFile,
  );
  process.stdout.write(`${responseFile}\n`);
  process.exitCode = response.status === "completed" ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const caught = error as Error;
    process.stderr.write(`${caught.stack ?? caught.message}\n`);
    process.exitCode = 1;
  });
}
