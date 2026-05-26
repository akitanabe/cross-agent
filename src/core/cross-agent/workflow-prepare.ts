import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildAdapterRequest } from "./envelope.ts";
import { buildInitialPrompt, buildNextRoundPrompt } from "./prompts.ts";
import { DEFAULT_OPTIONS, artifact, nowIso, resolveDataDir, validateRoundNumber, writeJsonAtomic } from "./state.ts";
import type {
  ArtifactRecord,
  PrepareInitialRoundInput,
  PrepareNextRoundInput,
  PrepareRoundResult,
  RoundKind,
  SessionPathSet,
  SessionState,
} from "./types.ts";
import { normalizePath, normalizePathList } from "../shared/path-utils.ts";
import { commandOutput, readSession } from "./workflow-common.ts";

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

  if (roundKind === "deep_dive" && previousResult.status !== "completed") {
    throw new Error(`deep_dive requires previous round status=completed, got ${previousResult.status}`);
  }
  if (roundKind === "recovery" && previousResult.status !== "failed") {
    throw new Error(`recovery requires previous round status=failed, got ${previousResult.status}`);
  }

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
