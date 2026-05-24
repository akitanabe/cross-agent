#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCommandArgs, parseIntegerOption, requireOption } from "../lib/cli-args.ts";
import {
  ADAPTER_RESPONSE_STATUSES,
  DEFAULT_OPTIONS,
  SUPPORTED_CONTRACT_VERSION,
  artifact,
  ensureDirectory,
  isPathInside,
  normalizeOptions,
  nowIso,
  readJson,
  resolveDataDir,
  sessionPaths,
  validateRoundNumber,
  writeJsonAtomic,
} from "../lib/cross-agent-state.ts";
import { buildAdapterRequest } from "../lib/cross-agent-envelope.ts";
import { buildInitialPrompt, buildNextRoundPrompt } from "../lib/cross-agent-prompts.ts";
import type {
  AdapterResponseEnvelope,
  AdapterResponseStatus,
  ArtifactRecord,
  CommandOutput,
  CompleteRoundInput,
  CrossAgentOptions,
  GetRoundInput,
  OutputType,
  PrepareInitialRoundInput,
  PrepareNextRoundInput,
  PrepareRoundResult,
  ReviewDepth,
  RoundKind,
  SessionPathSet,
  SessionState,
  StartSessionInput,
} from "../lib/cross-agent-types.ts";
import { normalizePath, normalizePathList } from "../lib/path-utils.ts";

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

export { buildAdapterRequest } from "../lib/cross-agent-envelope.ts";
export { buildInitialPrompt, buildNextRoundPrompt } from "../lib/cross-agent-prompts.ts";
export { normalizeOptions, sessionPaths } from "../lib/cross-agent-state.ts";

// review_session_id から session state を読み込む。
async function readSession(
  dataDir: string,
  reviewSessionId: string | null | undefined,
): Promise<{ paths: SessionPathSet; state: SessionState }> {
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const paths = sessionPaths(dataDir, reviewSessionId);
  const state = await readJson<SessionState>(paths.stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

  return { paths, state };
}

// round の prompt、adapter request、state entry をまとめて作成する。
async function prepareRound({
  paths,
  state,
  reviewSessionId,
  agent,
  round,
  roundKind,
  promptText,
  contextFile,
  targetFiles,
  focusQuestion,
  resetRounds = false,
  extraArtifacts = [],
  updateState = null,
}: {
  paths: SessionPathSet;
  state: SessionState;
  reviewSessionId: string;
  agent: string;
  round: number;
  roundKind: RoundKind;
  promptText: string;
  contextFile: string | null;
  targetFiles: string[];
  focusQuestion: string | null;
  resetRounds?: boolean;
  extraArtifacts?: ArtifactRecord[];
  updateState?: ((input: { promptFile: string; now: string }) => void) | null;
}): Promise<PrepareRoundResult> {
  const promptFile = resolve(paths.artifactDir, `round-${round}-prompt.md`);
  const normalizedPromptFile = normalizePath(promptFile);
  const normalizedContextFile = normalizePath(contextFile);
  await writeFile(promptFile, promptText, "utf8");

  const adapterRequest = buildAdapterRequest({
    reviewSessionId,
    agent,
    round,
    roundKind,
    targetRoot: state.target_root,
    promptFile: normalizedPromptFile,
    contextFile: normalizedContextFile,
    targetFiles,
    focusQuestion,
    options: state.options,
  });

  const adapterRequestFile = resolve(paths.artifactDir, `round-${round}-adapter-request.json`);
  const normalizedAdapterRequestFile = normalizePath(adapterRequestFile);
  await writeJsonAtomic(adapterRequestFile, adapterRequest);

  const now = nowIso();
  state.updated_at = now;
  state.current_round = round;
  updateState?.({ promptFile: normalizedPromptFile, now });

  const roundEntry = {
    round,
    kind: roundKind,
    agent,
    prompt_file: normalizedPromptFile,
    started_at: now,
    completed_at: null,
    agent_result: null,
  };
  if (resetRounds) {
    state.rounds = [roundEntry];
  } else {
    state.rounds ??= [];
    state.rounds.push(roundEntry);
  }

  state.artifacts ??= { files: [] };
  state.artifacts.files ??= [];
  state.artifacts.files.push(
    ...extraArtifacts,
    artifact(normalizedPromptFile, "prompt", round, agent),
    artifact(normalizedAdapterRequestFile, "adapter_request", round, agent),
  );

  await writeJsonAtomic(paths.stateFile, state);

  return {
    ...commandOutput("text", normalizedAdapterRequestFile),
    request_file: normalizedAdapterRequestFile,
    envelope: adapterRequest,
  };
}

// review session の空 state を作成する。
export async function startSession(input: StartSessionInput): Promise<CommandOutput<string>> {
  const dataDir = resolveDataDir(input.data_dir);
  const targetRoot = normalizePath(input.target_root);
  if (!targetRoot) throw new Error("target_root is required.");
  await ensureDirectory(targetRoot, "target_root");

  const reviewSessionId = input.review_session_id ?? randomUUID();
  const paths = sessionPaths(dataDir, reviewSessionId);
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.artifactDir, { recursive: true });

  const options = normalizeOptions(input.options);
  const createdAt = nowIso();
  const state = {
    schema_version: 1,
    review_session_id: reviewSessionId,
    created_at: createdAt,
    updated_at: createdAt,
    status: "active",
    target_root: targetRoot,
    current_round: 0,
    options,
    context: {
      context_file: null,
      initial_prompt_file: null,
      focus_question: null,
      target_files: [],
      source: "files",
    },
    rounds: [],
    artifacts: {
      files: [],
    },
    errors: [],
  };

  await writeJsonAtomic(paths.stateFile, state);

  return commandOutput("text", reviewSessionId);
}

// 初回 round に必要な artifact、prompt、adapter request を作成する。
export async function prepareInitialRound(input: PrepareInitialRoundInput): Promise<PrepareRoundResult> {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const { paths, state } = await readSession(dataDir, reviewSessionId);

  const agent = input.agent ?? "codex";
  const targetFiles = normalizePathList(input.target_files ?? []) as string[];
  const focusQuestion = input.focus_question ?? null;
  const contextText = input.context_text ?? null;
  const source = input.source ?? (contextText && targetFiles.length ? "mixed" : contextText ? "conversation" : "files");

  let contextFile = null;
  const artifacts: ArtifactRecord[] = [];
  if (contextText) {
    // context_text はすでに要約済みの入力として扱い、ここでは保存だけ行う。
    contextFile = resolve(paths.artifactDir, "context.md");
    const normalizedContextFile = normalizePath(contextFile);
    await writeFile(contextFile, contextText.endsWith("\n") ? contextText : `${contextText}\n`, "utf8");
    artifacts.push(artifact(normalizedContextFile, "context"));
    contextFile = normalizedContextFile;
  }

  const promptText = buildInitialPrompt({ focusQuestion, contextFile, targetFiles });
  return prepareRound({
    paths,
    state,
    reviewSessionId,
    agent,
    round: 1,
    roundKind: "initial_review",
    promptText,
    contextFile,
    targetFiles,
    focusQuestion,
    resetRounds: true,
    extraArtifacts: artifacts,
    updateState: ({ promptFile }) => {
      state.context = {
        context_file: contextFile,
        initial_prompt_file: promptFile,
        focus_question: focusQuestion,
        target_files: targetFiles,
        source,
      };
    },
  });
}

// 追加 round に必要な prompt と adapter request を作成する。
export async function prepareNextRound(input: PrepareNextRoundInput): Promise<PrepareRoundResult> {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const { paths, state } = await readSession(dataDir, reviewSessionId);
  if (state.status !== "active") {
    throw new Error(`session is not active: ${state.status}`);
  }

  const rounds = state.rounds ?? [];
  if (input.previous_round !== undefined) validateRoundNumber(input.previous_round);
  const previousRound =
    input.previous_round !== undefined
      ? rounds.find((entry) => entry.round === input.previous_round)
      : rounds.slice().reverse()[0];
  if (!previousRound) throw new Error("previous round not found.");
  if (!previousRound.agent_result) {
    throw new Error(`previous round is not completed: ${previousRound.round}/${previousRound.agent}`);
  }

  const previousResult = previousRound.agent_result;
  const agent = input.agent ?? previousRound.agent;
  const roundKind = input.round_kind ?? "follow_up";
  const focusQuestion = input.focus_question ?? state.context?.focus_question ?? null;
  const targetFiles = normalizePathList(input.target_files ?? state.context?.target_files ?? []) as string[];
  const contextFile = state.context?.context_file ?? null;
  const nextRound = Math.max(0, ...rounds.map((entry) => entry.round)) + 1;

  // round_kind ごとの前提条件: deep_dive は前 round の成功結果を掘るための round なので
  // status: completed を必須、recovery は失敗復旧用なので status: failed を必須にする。
  // follow_up は仕様上「statusは completed を推奨」なので緩めに許す。
  if (roundKind === "deep_dive" && previousResult.status !== "completed") {
    throw new Error(`deep_dive requires previous round status=completed, got ${previousResult.status}`);
  }
  if (roundKind === "recovery" && previousResult.status !== "failed") {
    throw new Error(`recovery requires previous round status=failed, got ${previousResult.status}`);
  }

  // max_rounds の予算は follow_up を除いて数える。follow_up は仕様上 max_rounds 対象外
  // なので、follow_up を挟んだ後に deep_dive / recovery が誤って詰まらないようにする。
  const maxRounds = state.options?.max_rounds ?? DEFAULT_OPTIONS.max_rounds;
  if (roundKind !== "follow_up") {
    const consumed = rounds.filter((entry) => entry.kind !== "follow_up").length;
    if (consumed >= maxRounds) {
      throw new Error(`max_rounds exceeded: ${consumed + 1} > ${maxRounds}`);
    }
  }

  const promptText = buildNextRoundPrompt({
    promptText: input.prompt_text,
    previousOutputFile: previousResult.output_file ?? null,
    focusQuestion,
  });
  return prepareRound({
    paths,
    state,
    reviewSessionId,
    agent,
    round: nextRound,
    roundKind,
    promptText,
    contextFile,
    targetFiles,
    focusQuestion,
  });
}

// adapter response envelope の必須フィールドと output_file の path containment を検証する。
// adapter runner 自体は信頼できるが、LLM/CLI 境界では契約ドリフトや subagent の
// 転記事故、prompt injection で envelope が偽造される可能性がある。安価な検証で防げる。
async function validateAdapterResponse(
  response: AdapterResponseEnvelope,
  paths: SessionPathSet,
  responseFile: string | null = null,
): Promise<void> {
  if (response.contract_version !== SUPPORTED_CONTRACT_VERSION) {
    throw new Error(`invalid adapter response: unsupported contract_version ${response.contract_version}`);
  }
  if (!ADAPTER_RESPONSE_STATUSES.has(response.status as AdapterResponseStatus)) {
    throw new Error(`invalid adapter response: unknown status ${response.status}`);
  }
  validateRoundNumber(response.round);

  if (responseFile) {
    if (!isPathInside(paths.artifactDir, responseFile)) {
      throw new Error(`invalid adapter response: response_file is outside artifact dir: ${responseFile}`);
    }
    let responseEntry;
    try {
      responseEntry = await stat(responseFile);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw new Error(`invalid adapter response: response_file does not exist: ${responseFile}`);
      }
      throw error;
    }
    if (!responseEntry.isFile()) {
      throw new Error(`invalid adapter response: response_file is not a file: ${responseFile}`);
    }
  }

  if (response.status === "completed") {
    if (typeof response.output_file !== "string" || response.output_file.length === 0) {
      throw new Error("invalid adapter response: completed requires output_file");
    }
    if (!isPathInside(paths.artifactDir, response.output_file)) {
      throw new Error(`invalid adapter response: output_file is outside artifact dir: ${response.output_file}`);
    }
    let entry;
    try {
      entry = await stat(response.output_file);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw new Error(`invalid adapter response: output_file does not exist: ${response.output_file}`);
      }
      throw error;
    }
    if (!entry.isFile()) {
      throw new Error(`invalid adapter response: output_file is not a file: ${response.output_file}`);
    }
  } else if (response.output_file != null) {
    throw new Error(`invalid adapter response: ${response.status} must not include output_file`);
  }
}

async function resolveAdapterResponseInput(
  input: CompleteRoundInput,
  dataDir: string,
): Promise<{ response: AdapterResponseEnvelope; responseFile: string }> {
  if (!input.response_file) throw new Error("response_file is required.");
  const responseFile = normalizePath(input.response_file);
  const artifactRoot = resolve(dataDir, "artifacts");
  if (!isPathInside(artifactRoot, responseFile)) {
    throw new Error(`invalid adapter response: response_file is outside artifact root: ${responseFile}`);
  }
  const response = await readJson<AdapterResponseEnvelope>(responseFile);
  return { response, responseFile };
}

// adapter response を既存 state の rounds[].agent_result に反映し、round を完了させる。
export async function completeRound(input: CompleteRoundInput): Promise<Record<string, unknown>> {
  // adapter は artifacts/errors を自分で append する。ここでは round 結果だけを閉じる。
  const dataDir = resolveDataDir(input.data_dir);
  const { response: agentResponse, responseFile } = await resolveAdapterResponseInput(input, dataDir);
  const reviewSessionId = agentResponse.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const paths = sessionPaths(dataDir, reviewSessionId);
  await validateAdapterResponse(agentResponse, paths, responseFile);

  const state = await readJson<SessionState>(paths.stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

  const round = state.rounds?.find((entry) => entry.round === agentResponse.round && entry.agent === agentResponse.agent);
  if (!round) throw new Error(`round not found: ${agentResponse.round}/${agentResponse.agent}`);

  round.completed_at = nowIso();
  round.agent_result = {
    agent: agentResponse.agent,
    round: agentResponse.round,
    status: agentResponse.status,
    output_file: normalizePath(agentResponse.output_file ?? null),
    error: agentResponse.error,
  };

  state.updated_at = nowIso();

  await writeJsonAtomic(paths.stateFile, state);
  return {
    review_session_id: state.review_session_id,
    state_file: paths.stateFile,
    round: agentResponse.round,
    agent: agentResponse.agent,
    status: agentResponse.status,
    response_file: responseFile,
  };
}

// state から対象 round の結果を取得する。
export async function getRound(input: GetRoundInput): Promise<{
  review_session_id: string;
  round: number;
  agent: string;
  status: string;
  output_file: string | null;
  error: unknown;
}> {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const stateFile = sessionPaths(dataDir, reviewSessionId).stateFile;
  const state = await readJson<SessionState>(stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

  const rounds = state.rounds ?? [];
  if (input.round !== undefined) validateRoundNumber(input.round);
  const round =
    input.round !== undefined
      ? rounds.find((entry) => entry.round === input.round)
      : rounds
          .slice()
          .reverse()
          .find((entry) => entry.agent_result?.output_file);

  if (!round) throw new Error("round not found.");
  const result = round.agent_result;
  if (!result) throw new Error(`round is not completed: ${round.round}/${round.agent}`);
  return {
    review_session_id: state.review_session_id,
    round: round.round,
    agent: round.agent,
    status: result.status,
    output_file: result.output_file,
    error: result.error,
  };
}

// round の output file を読み、CLI が stdout へ出す text output を作る。
export async function getRoundOutput(input: GetRoundInput): Promise<CommandOutput<string>> {
  const round = await getRound(input);
  if (!round.output_file) throw new Error(`round has no output_file: ${round.round}/${round.agent}`);
  return commandOutput("text", await readFile(round.output_file, "utf8"));
}

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

// CLI 引数を、この runner が扱う command option に変換する。
function parseArgs(argv: string[]): CliArgs & { command: string | null; help?: boolean } {
  return parseCommandArgs<CliArgs>(argv, { commands: commandArgs, commonOptions });
}

// CLI の使い方テキストを返す。
function usage(): string {
  return `Usage:
  node scripts/utils-runner.mjs normalize-path <path...>
${Object.values(commandArgs).map((command) => `  node scripts/cross-agent-runner.mjs ${command.usage}`).join("\n")}`;
}

// command result を stdout へ出す形式へそろえる。
function commandOutput<T>(outputType: OutputType, content: T): CommandOutput<T> {
  return { output_type: outputType, content };
}

function writeCommandOutput(result: CommandOutput): void {
  if (result.output_type === "text") {
    const text = String(result.content ?? "");
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.content, null, 2)}\n`);
}

// CLI entrypoint。command に応じて prepare-initial または complete-round を実行する。
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const command = commandArgs[args.command];
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
