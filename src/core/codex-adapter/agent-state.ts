import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AdapterResponseArtifact } from "../shared/adapter-envelope.ts";
import {
  agentStateFileFor,
  readJson,
  readJsonIfExists,
  sessionStateFileFor,
  writeJsonAtomic,
  nowIso,
} from "./state.ts";
import type { AdapterRequestInput, ArtifactPathSet, CodexAgentState, CodexRunSpec, SessionState } from "./types.ts";

// agent state の artifacts に adapter 生成 artifact を追記する。
export async function appendAgentArtifacts(
  agentState: CodexAgentState,
  artifacts: AdapterResponseArtifact[],
): Promise<void> {
  agentState.artifacts ??= [];
  agentState.artifacts.push(...artifacts);
}

export async function saveAgentState(
  dataDir: string,
  reviewSessionId: string,
  agentState: CodexAgentState,
): Promise<void> {
  const agentStateFile = agentStateFileFor(dataDir, reviewSessionId);
  await mkdir(dirname(agentStateFile), { recursive: true });
  await writeJsonAtomic(agentStateFile, agentState);
}

export async function readSessionState(dataDir: string, reviewSessionId: string): Promise<SessionState> {
  return await readJson<SessionState>(sessionStateFileFor(dataDir, reviewSessionId));
}

export async function readOrCreateAgentState(dataDir: string, request: AdapterRequestInput): Promise<CodexAgentState> {
  const agentStateFile = agentStateFileFor(dataDir, request.review_session_id);
  return (
    (await readJsonIfExists<CodexAgentState>(agentStateFile)) ?? {
      schema_version: 1,
      review_session_id: request.review_session_id,
      agent: "codex",
      status: "pending",
      thread_id: null,
      target_root: null,
      last_run_file: null,
      last_output_file: null,
      last_event_log: null,
      last_exit_file: null,
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
  agentState: CodexAgentState,
): Promise<void> {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent: "codex",
    status: "prepared",
    target_root: agentState.target_root ?? request.target_root,
    last_run_file: paths.runFile,
    last_event_log: paths.eventLog,
    last_exit_file: paths.exitFile,
    last_error: null,
  });
  await saveAgentState(dataDir, request.review_session_id, agentState);
}

export async function markAgentCompleted({
  dataDir,
  runSpec,
  paths,
  agentState,
  threadId,
  artifacts,
}: {
  dataDir: string;
  runSpec: CodexRunSpec;
  paths: ArtifactPathSet;
  agentState: CodexAgentState;
  threadId: string;
  artifacts: AdapterResponseArtifact[];
}): Promise<void> {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: runSpec.review_session_id,
    agent: "codex",
    status: "active",
    thread_id: threadId,
    target_root: runSpec.target_root,
    last_run_file: paths.runFile,
    last_output_file: runSpec.output_file,
    last_event_log: runSpec.event_log,
    last_exit_file: runSpec.exit_file,
    last_error: null,
  });
  await appendAgentArtifacts(agentState, artifacts);
  await saveAgentState(dataDir, runSpec.review_session_id, agentState);
}
