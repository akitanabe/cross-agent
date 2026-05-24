import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildAdapterRequest } from "./cross-agent-envelope.ts";
import { buildInitialPrompt, buildNextRoundPrompt } from "./cross-agent-prompts.ts";
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
} from "./cross-agent-state.ts";
import type {
  AdapterResponseEnvelope,
  AdapterResponseStatus,
  ArtifactRecord,
  CommandOutput,
  CompleteRoundInput,
  GetRoundInput,
  OutputType,
  PrepareInitialRoundInput,
  PrepareNextRoundInput,
  PrepareRoundResult,
  RoundKind,
  SessionPathSet,
  SessionState,
  StartSessionInput,
} from "./cross-agent-types.ts";
import { normalizePath, normalizePathList } from "./path-utils.ts";

export function commandOutput<T>(outputType: OutputType, content: T): CommandOutput<T> {
  return { output_type: outputType, content };
}

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
  const normalizedPromptFile = normalizePath(promptFile) as string;
  const normalizedContextFile = normalizePath(contextFile) as string | null;
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
  const normalizedAdapterRequestFile = normalizePath(adapterRequestFile) as string;
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
  const targetRoot = normalizePath(input.target_root) as string | null;
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
    const normalizedContextFile = normalizePath(contextFile) as string;
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
  const responseFile = normalizePath(input.response_file) as string;
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
    output_file: normalizePath(agentResponse.output_file ?? null) as string | null,
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
