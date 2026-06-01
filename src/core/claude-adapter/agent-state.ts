import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AdapterResponseArtifact } from "../shared/adapter-envelope.ts";
import {
  agentContextFileFor,
  agentStateFileFor,
  nowIso,
  readJson,
  readJsonIfExists,
  sessionStateFileFor,
  writeJsonAtomic,
} from "./state.ts";
import type { AdapterRequestInput, ArtifactPathSet, ClaudeAgentState, SessionState } from "./types.ts";

export async function appendAgentArtifacts(
  agentState: ClaudeAgentState,
  artifacts: AdapterResponseArtifact[],
): Promise<void> {
  agentState.artifacts ??= [];
  agentState.artifacts.push(...artifacts);
}

export async function saveAgentState(
  dataDir: string,
  reviewSessionId: string,
  agentState: ClaudeAgentState,
): Promise<void> {
  const agentStateFile = agentStateFileFor(dataDir, reviewSessionId, agentState.agent_id);
  await mkdir(dirname(agentStateFile), { recursive: true });
  await writeJsonAtomic(agentStateFile, agentState);
}

export async function readSessionState(dataDir: string, reviewSessionId: string): Promise<SessionState> {
  const state = await readJson<SessionState>(sessionStateFileFor(dataDir, reviewSessionId));
  if (state.schema_version !== 2) {
    throw new Error(`unsupported agent-review session schema_version ${state.schema_version ?? "missing"}; expected 2.`);
  }
  return state;
}

export async function readOrCreateAgentState(dataDir: string, request: AdapterRequestInput): Promise<ClaudeAgentState> {
  const agentStateFile = agentStateFileFor(dataDir, request.review_session_id, request.agent_id);
  return (
    (await readJsonIfExists<ClaudeAgentState>(agentStateFile)) ?? {
      schema_version: 1,
      review_session_id: request.review_session_id,
      agent_id: request.agent_id,
      adapter: "claude",
      status: "pending",
      target_root: null,
      context_file: agentContextFileFor(dataDir, request.review_session_id, request.agent_id),
      last_input_file: null,
      last_output_file: null,
      last_error: null,
      artifacts: [],
      errors: [],
    }
  );
}

export async function markAgentPrepared(
  dataDir: string,
  request: AdapterRequestInput,
  paths: ArtifactPathSet,
  contextFile: string,
  agentState: ClaudeAgentState,
): Promise<void> {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "claude",
    status: "prepared",
    target_root: request.target_root,
    context_file: contextFile,
    last_input_file: paths.inputFile,
    last_error: null,
  });
  await saveAgentState(dataDir, request.review_session_id, agentState);
}

export async function markAgentCompleted({
  dataDir,
  request,
  paths,
  contextFile,
  agentState,
  artifacts,
}: {
  dataDir: string;
  request: AdapterRequestInput;
  paths: ArtifactPathSet;
  contextFile: string;
  agentState: ClaudeAgentState;
  artifacts: AdapterResponseArtifact[];
}): Promise<void> {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "claude",
    status: "active",
    target_root: request.target_root,
    context_file: contextFile,
    last_input_file: paths.inputFile,
    last_output_file: paths.outputFile,
    last_error: null,
  });
  await appendAgentArtifacts(agentState, artifacts);
  await saveAgentState(dataDir, request.review_session_id, agentState);
}
