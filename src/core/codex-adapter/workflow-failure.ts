import type { AdapterResponseEnvelope } from "../shared/adapter-envelope.ts";
import { artifact, makeError, makeResponse, nowIso, writeDiagnostic, writeJsonAtomic } from "./state.ts";
import { appendAgentArtifacts, saveAgentState } from "./agent-state.ts";
import type {
  AdapterRequestWithDataDir,
  ArtifactPathSet,
  CodexAgentState,
  CodexCompleteResult,
} from "./types.ts";
import { responsePath } from "./workflow-common.ts";

export class CodexPrepareFailedError extends Error {
  path: string;
  response: AdapterResponseEnvelope;

  constructor(path: string, response: AdapterResponseEnvelope) {
    super(response.error?.message ?? "Codex prepare failed.");
    this.name = "CodexPrepareFailedError";
    this.path = path;
    this.response = response;
  }
}

export type FailureInput = {
  request: AdapterRequestWithDataDir;
  agentState: CodexAgentState | null;
  paths: ArtifactPathSet;
  code: string;
  message: string;
  exitCode?: number | null;
  extraDiagnostics?: Array<string | null | undefined>;
};

async function writeFailureDiagnostic({
  request,
  paths,
  code,
  message,
  exitCode = null,
  extraDiagnostics = [],
}: FailureInput): Promise<void> {
  await writeDiagnostic(paths.diagnosticFile, [
    `# Codex adapter diagnostic`,
    ``,
    `- status: failed`,
    `- code: ${code}`,
    `- message: ${message}`,
    `- round: ${request.round}`,
    `- target_root: ${request.target_root}`,
    exitCode !== null ? `- exit_code: ${exitCode}` : null,
    ...extraDiagnostics,
  ]);
}

async function updateFailedAgentState({ request, agentState, paths, code, message }: FailureInput): Promise<void> {
  if (!agentState) return;

  const error = makeError(code, message, paths.diagnosticFile);
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent: "codex",
    status: "failed",
    thread_id: agentState.thread_id ?? null,
    target_root: agentState.target_root ?? request.target_root,
    last_run_file: agentState.last_run_file ?? paths.runFile,
    last_output_file: agentState.last_output_file ?? null,
    last_event_log: paths.eventLog,
    last_exit_file: paths.exitFile,
    last_error: error,
  });
  await appendAgentArtifacts(agentState, [artifact(paths.diagnosticFile, "diagnostic", request.round)]);
  agentState.errors ??= [];
  agentState.errors.push({ ...error, agent: "codex", round: request.round, created_at: nowIso() });
  await saveAgentState(request.data_dir ?? ".", request.review_session_id, agentState);
}

// 失敗時の diagnostic、response envelope、可能なら agent state 更新をまとめて行う。
async function handleFailure(input: FailureInput): Promise<AdapterResponseEnvelope> {
  // 失敗時も response envelope を返し、agent state が有効なら復旧可能な診断を追記する。
  const diagnosticArtifact = artifact(input.paths.diagnosticFile, "diagnostic", input.request.round);
  const error = makeError(input.code, input.message, input.paths.diagnosticFile);
  const response = makeResponse(input.request, "failed", null, [diagnosticArtifact], error);

  await writeFailureDiagnostic(input);
  await updateFailedAgentState(input);

  await writeJsonAtomic(input.paths.responseFile, response);
  return response;
}

export async function failPrepare(input: FailureInput): Promise<never> {
  const response = await handleFailure(input);
  throw new CodexPrepareFailedError(responsePath(input.paths), response);
}

export async function failComplete(input: FailureInput): Promise<CodexCompleteResult> {
  const response = await handleFailure(input);
  return { path: responsePath(input.paths), response };
}
