import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseCommandArgs, parseIntegerOption, requireOption } from "./cli-args.ts";
import { sessionPaths } from "./cross-agent-state.ts";
import {
  commandOutput,
  completeRound,
  getRoundOutput,
  prepareInitialRound,
  prepareNextRound,
  startSession,
} from "./cross-agent-workflow.ts";
import type {
  CommandOutput,
  CompleteRoundInput,
  CrossAgentOptions,
  GetRoundInput,
  PrepareInitialRoundInput,
  PrepareNextRoundInput,
  ReviewDepth,
  RoundKind,
  StartSessionInput,
} from "./cross-agent-types.ts";

type CliArgs = Record<string, unknown> & {
  command?: string | null;
  help?: boolean;
  dataDir?: string;
  targetRoot?: string;
  reviewSessionId?: string;
  reviewDepth?: ReviewDepth;
  maxRounds?: number;
  agent?: string;
  focusQuestion?: string;
  contextFile?: string;
  targetFiles?: string[];
  roundKind?: RoundKind;
  promptFile?: string;
  previousRound?: number;
  responseFile?: string;
  round?: number;
};

type CommandDefinition = {
  usage: string;
  options: Record<string, { field: string; multiple?: boolean; parse?: (value: string, optionName: string) => unknown }>;
  buildInput: (args: CliArgs) => Promise<unknown>;
  run: (input: unknown) => Promise<CommandOutput>;
};

function optionInput(args: CliArgs): Partial<CrossAgentOptions> | undefined {
  const options: Partial<CrossAgentOptions> = {};
  if (args.reviewDepth != null) options.review_depth = args.reviewDepth;
  if (args.maxRounds != null) options.max_rounds = args.maxRounds;
  return Object.keys(options).length ? options : undefined;
}

async function readOptionalTextFile(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) return null;
  return readFile(filePath, "utf8");
}

async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return null;
    throw error;
  }
}

function commonInput(args: CliArgs): { data_dir: string } {
  return { data_dir: requireOption(args, "dataDir", "--data-dir") as string };
}

async function readPrepareInitialContext(args: CliArgs): Promise<string | null> {
  if (args.contextFile) return readOptionalTextFile(args.contextFile);
  const dataDir = requireOption(args, "dataDir", "--data-dir") as string;
  const reviewSessionId = requireOption(args, "reviewSessionId", "--review-session-id") as string;
  const defaultContextFile = resolve(sessionPaths(dataDir, reviewSessionId).artifactDir, "context.md");
  return readTextFileIfExists(defaultContextFile);
}

const commonOptions: Record<string, { field: string }> = {
  "--data-dir": { field: "dataDir" },
};

// command ごとの CLI surface をここに集約する。新しい option は対象 command だけへ足す。
const commandArgs: Record<string, CommandDefinition> = {
  "start-session": {
    usage:
      "start-session --data-dir <CLAUDE_PLUGIN_DATA> --target-root <root> [--review-session-id <id>] [--review-depth <level>] [--max-rounds <n>]",
    options: {
      "--target-root": { field: "targetRoot" },
      "--review-session-id": { field: "reviewSessionId" },
      "--review-depth": { field: "reviewDepth" },
      "--max-rounds": { field: "maxRounds", parse: parseIntegerOption },
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: args.reviewSessionId,
      target_root: requireOption(args, "targetRoot", "--target-root") as string,
      options: optionInput(args),
    }),
    run: (input) => startSession(input as StartSessionInput),
  },
  "prepare-initial": {
    usage:
      "prepare-initial --data-dir <CLAUDE_PLUGIN_DATA> --review-session-id <id> [--agent <agent>] [--focus-question <text>] [--context-file <path>] [--target-files <file...>]",
    options: {
      "--review-session-id": { field: "reviewSessionId" },
      "--agent": { field: "agent" },
      "--focus-question": { field: "focusQuestion" },
      "--context-file": { field: "contextFile" },
      "--target-files": { field: "targetFiles", multiple: true },
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: requireOption(args, "reviewSessionId", "--review-session-id") as string,
      agent: args.agent,
      focus_question: args.focusQuestion,
      context_text: await readPrepareInitialContext(args),
      target_files: args.targetFiles ?? [],
    }),
    run: (input) => prepareInitialRound(input as PrepareInitialRoundInput),
  },
  "prepare-next-round": {
    usage:
      "prepare-next-round --data-dir <CLAUDE_PLUGIN_DATA> --review-session-id <id> --prompt-file <path> [--agent <agent>] [--round-kind <kind>] [--previous-round <n>] [--focus-question <text>] [--target-files <file...>]",
    options: {
      "--review-session-id": { field: "reviewSessionId" },
      "--agent": { field: "agent" },
      "--round-kind": { field: "roundKind" },
      "--prompt-file": { field: "promptFile" },
      "--previous-round": { field: "previousRound", parse: parseIntegerOption },
      "--focus-question": { field: "focusQuestion" },
      "--target-files": { field: "targetFiles", multiple: true },
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: requireOption(args, "reviewSessionId", "--review-session-id") as string,
      agent: args.agent,
      round_kind: args.roundKind,
      prompt_text: await readOptionalTextFile(requireOption(args, "promptFile", "--prompt-file") as string),
      previous_round: args.previousRound,
      focus_question: args.focusQuestion,
      target_files: args.targetFiles,
    }),
    run: (input) => prepareNextRound(input as PrepareNextRoundInput),
  },
  "complete-round": {
    usage: "complete-round --data-dir <CLAUDE_PLUGIN_DATA> --response-file <response-envelope.json>",
    options: {
      "--response-file": { field: "responseFile" },
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      response_file: requireOption(args, "responseFile", "--response-file") as string,
    }),
    run: async (input) => commandOutput("json", await completeRound(input as CompleteRoundInput)),
  },
  "get-round-output": {
    usage: "get-round-output --data-dir <CLAUDE_PLUGIN_DATA> --review-session-id <id> [--round <n>]",
    options: {
      "--review-session-id": { field: "reviewSessionId" },
      "--round": { field: "round", parse: parseIntegerOption },
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: requireOption(args, "reviewSessionId", "--review-session-id") as string,
      round: args.round,
    }),
    run: (input) => getRoundOutput(input as GetRoundInput),
  },
};

export function parseArgs(argv: string[]): CliArgs & { command: string | null; help?: boolean } {
  return parseCommandArgs<CliArgs>(argv, { commands: commandArgs, commonOptions });
}

export function commandFor(name: string): CommandDefinition | undefined {
  return commandArgs[name];
}

export function usage(): string {
  return `Usage:
  node scripts/utils-runner.mjs normalize-path <path...>
${Object.values(commandArgs).map((command) => `  node scripts/cross-agent-runner.mjs ${command.usage}`).join("\n")}`;
}
