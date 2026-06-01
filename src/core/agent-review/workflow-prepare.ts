import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizePath, normalizePathList } from "../shared/path-utils.ts";
import { buildAdapterRequest } from "./envelope.ts";
import { buildInitialPrompt, buildNextRoundPrompt } from "./prompts.ts";
import {
  artifact,
  normalizeAgentLaunchSpecs,
  nowIso,
  resolveDataDir,
  validateRoundNumber,
  writeJsonAtomic,
} from "./state.ts";
import type {
  AgentLaunchSpec,
  ArtifactRecord,
  PrepareInitialRoundInput,
  PrepareNextRoundInput,
  PrepareRequestResult,
  PrepareRoundResult,
  RoundAgentState,
  RoundKind,
  SessionPathSet,
  SessionState,
} from "./types.ts";
import { commandOutput, readSession } from "./workflow-common.ts";

function responseFileFor(paths: SessionPathSet, round: number, agentId: string): string {
  return normalizePath(resolve(paths.artifactDir, `round-${round}-${agentId}-response.json`)) as string;
}

async function writeAgentRequest({
  paths,
  state,
  reviewSessionId,
  spec,
  round,
  roundKind,
  promptText,
  contextFile,
  targetFiles,
  focusQuestion,
}: {
  paths: SessionPathSet;
  state: SessionState;
  reviewSessionId: string;
  spec: AgentLaunchSpec;
  round: number;
  roundKind: RoundKind;
  promptText: string;
  contextFile: string | null;
  targetFiles: string[];
  focusQuestion: string | null;
}): Promise<{
  agentState: RoundAgentState;
  request: PrepareRequestResult;
  envelope: ReturnType<typeof buildAdapterRequest>;
}> {
  const promptFile = normalizePath(resolve(paths.artifactDir, `round-${round}-${spec.agent_id}-prompt.md`)) as string;
  await writeFile(promptFile, promptText, "utf8");

  const envelope = buildAdapterRequest({
    reviewSessionId,
    agentId: spec.agent_id,
    adapter: spec.adapter,
    round,
    roundKind,
    targetRoot: state.target_root,
    promptFile,
    contextFile: normalizePath(contextFile) as string | null,
    targetFiles,
    focusQuestion,
    options: state.options,
  });

  const requestFile = normalizePath(
    resolve(paths.artifactDir, `round-${round}-${spec.agent_id}-adapter-request.json`),
  ) as string;
  await writeJsonAtomic(requestFile, envelope);

  const now = nowIso();
  return {
    agentState: {
      agent_id: spec.agent_id,
      adapter: spec.adapter,
      status: "pending",
      prompt_file: promptFile,
      adapter_request_file: requestFile,
      response_file: responseFileFor(paths, round, spec.agent_id),
      started_at: now,
      completed_at: null,
      agent_result: null,
    },
    request: {
      agent_id: spec.agent_id,
      adapter: spec.adapter,
      request_file: requestFile,
    },
    envelope,
  };
}

async function prepareRound({
  paths,
  state,
  reviewSessionId,
  agents,
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
  agents: AgentLaunchSpec[];
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
  const prepared = [];
  for (const spec of agents) {
    prepared.push(
      await writeAgentRequest({
        paths,
        state,
        reviewSessionId,
        spec,
        round,
        roundKind,
        promptText,
        contextFile,
        targetFiles,
        focusQuestion,
      }),
    );
  }

  const now = nowIso();
  state.updated_at = now;
  state.current_round = round;
  updateState?.({ promptFile: prepared[0]?.agentState.prompt_file ?? "", now });

  const roundEntry = {
    round,
    kind: roundKind,
    started_at: now,
    completed_at: null,
    agents: prepared.map((entry) => entry.agentState),
  };
  if (resetRounds) {
    state.rounds = [roundEntry];
  } else {
    state.rounds ??= [];
    const existing = state.rounds.find((entry) => entry.round === round);
    if (existing) {
      const existingIds = new Set(existing.agents.map((agent) => agent.agent_id));
      for (const agentState of roundEntry.agents) {
        if (existingIds.has(agentState.agent_id))
          throw new Error(`duplicate agent_id in round: ${agentState.agent_id}`);
      }
      existing.agents.push(...roundEntry.agents);
    } else {
      state.rounds.push(roundEntry);
    }
  }

  state.artifacts ??= { files: [] };
  state.artifacts.files ??= [];
  state.artifacts.files.push(
    ...extraArtifacts,
    ...prepared.flatMap((entry) => [
      artifact(entry.agentState.prompt_file, "prompt", round, entry.agentState.agent_id, entry.agentState.adapter),
      artifact(
        entry.agentState.adapter_request_file,
        "adapter_request",
        round,
        entry.agentState.agent_id,
        entry.agentState.adapter,
      ),
    ]),
  );

  await writeJsonAtomic(paths.stateFile, state);

  const requests = prepared.map((entry) => entry.request);
  return {
    ...commandOutput("json", { review_session_id: reviewSessionId, round, requests }),
    requests,
    envelopes: prepared.map((entry) => entry.envelope),
  };
}

export async function prepareInitialRound(input: PrepareInitialRoundInput): Promise<PrepareRoundResult> {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const { paths, state } = await readSession(dataDir, reviewSessionId);

  const agents = normalizeAgentLaunchSpecs(input);
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
    agents,
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

function completedAgentForKind(previousRound: SessionState["rounds"][number], spec: AgentLaunchSpec): RoundAgentState {
  const previousAgent = previousRound.agents.find((agent) => agent.agent_id === spec.agent_id);
  if (!previousAgent) {
    throw new Error(`previous round has no agent_id ${spec.agent_id}.`);
  }
  return previousAgent;
}

function previousOutputForFollowUp({
  previousRound,
  previousAgentId,
}: {
  previousRound: SessionState["rounds"][number];
  previousAgentId?: string | null;
}): string | null {
  if (previousAgentId) {
    const agent = previousRound.agents.find((entry) => entry.agent_id === previousAgentId);
    if (!agent) throw new Error(`previous round has no previous_agent_id ${previousAgentId}.`);
    return agent.agent_result?.output_file ?? null;
  }
  const agentsWithOutput = previousRound.agents.filter((agent) => agent.agent_result?.output_file);
  if (agentsWithOutput.length > 1) {
    throw new Error("previous output is ambiguous; specify previous_agent_id.");
  }
  return agentsWithOutput[0]?.agent_result?.output_file ?? null;
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

  const agents =
    input.agent_id != null || input.adapter != null || input.agents != null
      ? normalizeAgentLaunchSpecs(input)
      : previousRound.agents.length === 1
        ? [{ agent_id: previousRound.agents[0].agent_id, adapter: previousRound.agents[0].adapter }]
        : (() => {
            throw new Error("previous round has multiple agents; specify --agent-id/--adapter or --agents.");
          })();

  const roundKind = input.round_kind ?? "follow_up";
  for (const spec of agents) {
    if (roundKind !== "deep_dive" && roundKind !== "recovery") continue;
    const previousAgent = completedAgentForKind(previousRound, spec);
    const previousResult = previousAgent.agent_result;
    if (!previousResult) {
      throw new Error(`previous round is not completed for agent_id ${spec.agent_id}.`);
    }
    if (roundKind === "deep_dive" && previousResult?.status !== "completed") {
      throw new Error(
        `deep_dive requires previous status=completed for agent_id ${spec.agent_id}, got ${previousResult?.status}`,
      );
    }
    if (roundKind === "recovery" && previousResult?.status !== "failed") {
      throw new Error(
        `recovery requires previous status=failed for agent_id ${spec.agent_id}, got ${previousResult?.status}`,
      );
    }
  }

  const focusQuestion = input.focus_question ?? state.context?.focus_question ?? null;
  const targetFiles = normalizePathList(input.target_files ?? state.context?.target_files ?? []) as string[];
  const contextFile = state.context?.context_file ?? null;
  const nextRound = Math.max(0, ...rounds.map((entry) => entry.round)) + 1;
  const previousOutputFile = previousOutputForFollowUp({
    previousRound,
    previousAgentId: input.previous_agent_id ?? null,
  });

  const promptText = buildNextRoundPrompt({
    promptText: input.prompt_text,
    previousOutputFile,
    focusQuestion,
  });
  return prepareRound({
    paths,
    state,
    reviewSessionId,
    agents,
    round: nextRound,
    roundKind,
    promptText,
    contextFile,
    targetFiles,
    focusQuestion,
  });
}
