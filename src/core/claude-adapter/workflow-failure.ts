import type { AdapterResponseEnvelope } from "../shared/adapter-envelope.ts";
import { appendAgentArtifacts, saveAgentState } from "./agent-state.ts";
import { artifact, makeError, makeResponse, nowIso, writeDiagnostic, writeJsonAtomic } from "./state.ts";
import type {
  AdapterRequestWithDataDir,
  ArtifactPathSet,
  ClaudeAgentState,
  ClaudeCompleteResult,
} from "./types.ts";
import { responsePath } from "./workflow-common.ts";

export class ClaudePrepareFailedError extends Error {
  path: string;
  response: AdapterResponseEnvelope;

  constructor(path: string, response: AdapterResponseEnvelope) {
    super(response.error?.message ?? "Claude prepare failed.");
    this.name = "ClaudePrepareFailedError";
    this.path = path;
    this.response = response;
  }
}

export type FailureInput = {
  request: AdapterRequestWithDataDir;
  agentState: ClaudeAgentState | null;
  paths: ArtifactPathSet;
  code: string;
  message: string;
  extraDiagnostics?: Array<string | null | undefined>;
};

async function writeFailureDiagnostic({
  request,
  paths,
  code,
  message,
  extraDiagnostics = [],
}: FailureInput): Promise<void> {
  await writeDiagnostic(paths.diagnosticFile, [
    `# Claude adapter diagnostic`,
    ``,
    `- status: failed`,
    `- code: ${code}`,
    `- message: ${message}`,
    `- round: ${request.round}`,
    `- target_root: ${request.target_root}`,
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
    agent: "claude",
    status: "failed",
    target_root: agentState.target_root ?? request.target_root,
    last_input_file: agentState.last_input_file ?? paths.inputFile,
    last_output_file: agentState.last_output_file ?? null,
    last_error: error,
  });
  await appendAgentArtifacts(agentState, [artifact(paths.diagnosticFile, "diagnostic", request.round)]);
  agentState.errors ??= [];
  agentState.errors.push({ ...error, agent: "claude", round: request.round, created_at: nowIso() });
  await saveAgentState(request.data_dir ?? ".", request.review_session_id, agentState);
}

async function handleFailure(input: FailureInput): Promise<AdapterResponseEnvelope> {
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
  throw new ClaudePrepareFailedError(responsePath(input.paths), response);
}

export async function failComplete(input: FailureInput): Promise<ClaudeCompleteResult> {
  const response = await handleFailure(input);
  return { path: responsePath(input.paths), response };
}
