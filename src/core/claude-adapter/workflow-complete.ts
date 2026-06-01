import { readFile } from "node:fs/promises";

import { normalizePath } from "../shared/path-utils.ts";
import { markAgentCompleted, readOrCreateAgentState, readSessionState } from "./agent-state.ts";
import { buildClaudeContext, writeTextFile } from "./context.ts";
import { failComplete } from "./workflow-failure.ts";
import {
  agentContextFileFor,
  artifact,
  artifactDirFor,
  artifactPaths,
  makeResponse,
  pathExists,
  validateRequest,
  writeDiagnostic,
  writeJsonAtomic,
} from "./state.ts";
import type {
  AdapterRequestInput,
  ClaudeAgentState,
  ClaudeCompleteResult,
  ClaudePrepareOptions,
  SessionState,
} from "./types.ts";
import { normalizeRequest, responsePath } from "./workflow-common.ts";

async function readNonEmptyOutput(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) return null;
  const text = await readFile(filePath, "utf8");
  return text.trim().length ? text : null;
}

export async function completeClaudeRun(
  request: AdapterRequestInput,
  outputFile: string,
  options: ClaudePrepareOptions = {},
): Promise<ClaudeCompleteResult> {
  const dataDir = options.dataDir ? (normalizePath(options.dataDir) as string) : null;
  request = normalizeRequest(request);
  outputFile = normalizePath(outputFile) as string;

  if (!dataDir) throw new Error("--data-dir is required.");

  const requestWithDataDir = { ...request, data_dir: dataDir };
  const artifactDir = artifactDirFor(dataDir, request.review_session_id ?? "unknown");
  const paths = artifactPaths(artifactDir, request.round ?? "unknown", request.agent_id ?? "unknown");

  const validationError = await validateRequest(request);
  if (validationError) {
    return failComplete({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: validationError.code,
      message: validationError.message,
    });
  }

  let sessionState: SessionState;
  let agentState: ClaudeAgentState;
  try {
    sessionState = await readSessionState(dataDir, request.review_session_id);
    if (sessionState.review_session_id !== request.review_session_id) {
      return failComplete({
        request: requestWithDataDir,
        agentState: null,
        paths,
        code: "state_file_invalid",
        message: "session state file review_session_id does not match request.",
      });
    }
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    return failComplete({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: caught.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message:
        caught.code === "ENOENT"
          ? "session state file does not exist."
          : `state file is not valid JSON: ${caught.message}`,
    });
  }

  if (agentState.review_session_id !== request.review_session_id || agentState.agent_id !== request.agent_id) {
    return failComplete({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Claude agent state file review_session_id or agent_id does not match request.",
    });
  }

  if (outputFile !== normalizePath(paths.outputFile)) {
    return failComplete({
      request: requestWithDataDir,
      agentState,
      paths,
      code: "claude_output_missing",
      message: "output-file does not match derived Claude output path.",
    });
  }

  if (!(await readNonEmptyOutput(paths.outputFile))) {
    return failComplete({
      request: requestWithDataDir,
      agentState,
      paths,
      code: "claude_output_missing",
      message: "Claude output file was not created or was empty.",
    });
  }

  const contextFile = agentContextFileFor(dataDir, request.review_session_id, request.agent_id);
  await writeTextFile(contextFile, buildClaudeContext({ request, sessionState, currentPaths: paths }));
  const artifacts = [
    artifact(paths.inputFile, "claude_input", request.round, request.agent_id),
    artifact(paths.outputFile, "agent_output", request.round, request.agent_id),
    artifact(paths.diagnosticFile, "diagnostic", request.round, request.agent_id),
  ];
  await writeDiagnostic(paths.diagnosticFile, [
    `# Claude adapter diagnostic`,
    ``,
    `- status: completed`,
    `- round: ${request.round}`,
    `- output_file: ${normalizePath(paths.outputFile)}`,
  ]);
  await markAgentCompleted({ dataDir, request, paths, contextFile, agentState, artifacts });

  const response = makeResponse(requestWithDataDir, "completed", paths.outputFile, artifacts, null);
  await writeJsonAtomic(paths.responseFile, response);
  return { path: responsePath(paths), response };
}
