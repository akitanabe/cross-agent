import { parseCommandArgs } from "../shared/cli-args.ts";
import type { ParsedCodexAdapterArgs } from "./types.ts";

const commonOptions = {
  "--data-dir": { field: "dataDir" },
};

const commands = {
  prepare: {
    options: {
      "--request": { field: "requestFile" },
      "-r": { field: "requestFile" },
    },
  },
  complete: {
    options: {
      "--run": { field: "runFile" },
    },
  },
};

// CLI 引数を、この runner が扱う command / option に変換する。
export function parseArgs(argv: string[]): ParsedCodexAdapterArgs {
  const parsed = parseCommandArgs(argv, {
    commands,
    commonOptions,
  }) as Partial<ParsedCodexAdapterArgs>;
  return {
    command: parsed.command ?? null,
    requestFile: parsed.requestFile ?? null,
    dataDir: parsed.dataDir ?? null,
    runFile: parsed.runFile ?? null,
    help: parsed.help,
  };
}

// CLI の使い方テキストを返す。
export function usage(): string {
  return `Usage:
  node scripts/codex-adapter-runner.mjs prepare --data-dir <CLAUDE_PLUGIN_DATA> --request <request-envelope.json>
  node scripts/codex-adapter-runner.mjs complete --data-dir <CLAUDE_PLUGIN_DATA> --run <round-N-codex-run.json>

prepare validates the request/session state and writes a Codex exec run spec. On success, stdout
contains only the run spec file path. On recoverable failure, prepare writes the failed response
envelope to the derived artifact path and exits with an error without printing that path to stdout.

complete validates Codex CLI artifacts written by codex-agent, updates Codex agent state, and
writes the adapter response envelope. stdout contains only the response envelope file path.`;
}
