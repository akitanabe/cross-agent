import { parseCommandArgs } from "../shared/cli-args.ts";
import type { ParsedClaudeAdapterArgs } from "./types.ts";

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
      "--request": { field: "requestFile" },
      "-r": { field: "requestFile" },
      "--output-file": { field: "outputFile" },
    },
  },
};

export function parseArgs(argv: string[]): ParsedClaudeAdapterArgs {
  const parsed = parseCommandArgs(argv, {
    commands,
    commonOptions,
  }) as Partial<ParsedClaudeAdapterArgs>;
  return {
    command: parsed.command ?? null,
    requestFile: parsed.requestFile ?? null,
    dataDir: parsed.dataDir ?? null,
    outputFile: parsed.outputFile ?? null,
    help: parsed.help,
  };
}

export function usage(): string {
  return `Usage:
  node scripts/claude-adapter-runner.mjs prepare --data-dir <CLAUDE_PLUGIN_DATA> --request <request-envelope.json>
  node scripts/claude-adapter-runner.mjs complete --data-dir <CLAUDE_PLUGIN_DATA> --request <request-envelope.json> --output-file <round-N-claude-output.md>

prepare validates the request/session state and writes the Claude input/context artifacts. On
success, stdout contains only the Claude input file path. On recoverable failure, prepare writes
the failed response envelope to the derived artifact path and exits with an error without printing
that path to stdout.

complete validates the Claude output artifact, updates Claude agent state, and writes the adapter
response envelope. stdout contains only the response envelope file path.`;
}
