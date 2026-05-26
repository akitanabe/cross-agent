import { mkdir } from "node:fs/promises";

import { normalizePath } from "../shared/path-utils.ts";
import { readOrCreateAgentState, readSessionState, markAgentPrepared } from "./agent-state.ts";
import { buildClaudeContext, buildClaudeInput, writeTextFile } from "./context.ts";
import { failPrepare } from "./workflow-failure.ts";
import {
  agentContextFileFor,
  artifactDirFor,
  artifactPaths,
  makeError,
  validateRequest,
} from "./state.ts";
import type {
  AdapterRequestInput,
  ClaudeAgentState,
  ClaudePrepareOptions,
  ClaudePrepareResult,
  SessionState,
} from "./types.ts";
import { inputPath, normalizeRequest, outputPath } from "./workflow-common.ts";

export async function prepareClaudeRun(
  request: AdapterRequestInput,
  options: ClaudePrepareOptions = {},
): Promise<ClaudePrepareResult> {
  const dataDir = options.dataDir ? (normalizePath(options.dataDir) as string) : null;
  request = normalizeRequest(request);

  if (!dataDir) {
    throw new Error(
      makeError(
        "invalid_request_envelope",
        '--data-dir is required. In plugin context, pass `--data-dir "${CLAUDE_PLUGIN_DATA}"` ' +
          "(Claude Code substitutes this in skill content).",
      ).message,
    );
  }

  const requestWithDataDir = { ...request, data_dir: dataDir };
  const artifactDir = artifactDirFor(dataDir, request.review_session_id ?? "unknown");
  const paths = artifactPaths(artifactDir, request.round ?? "unknown");
  await mkdir(artifactDir, { recursive: true });

  const validationError = await validateRequest(request);
  if (validationError) {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: validationError.code,
      message: validationError.message,
    });
  }

  let sessionState: SessionState;
  try {
    sessionState = await readSessionState(dataDir, request.review_session_id);
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: caught.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message:
        caught.code === "ENOENT"
          ? "session state file does not exist."
          : `session state file is not valid JSON: ${caught.message}`,
    });
  }

  if (sessionState.review_session_id !== request.review_session_id) {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "session state file review_session_id does not match request.",
    });
  }

  let agentState: ClaudeAgentState;
  try {
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error as Error;
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: `Claude agent state file is not valid JSON: ${caught.message}`,
    });
  }

  if (agentState.review_session_id !== request.review_session_id || agentState.agent !== "claude") {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Claude agent state file review_session_id or agent does not match request.",
    });
  }

  const contextFile = agentContextFileFor(dataDir, request.review_session_id);
  await writeTextFile(paths.inputFile, buildClaudeInput({ request, contextFile, outputFile: paths.outputFile }));
  await writeTextFile(paths.diagnosticFile, `# Claude adapter diagnostic\n\n- status: prepared\n- round: ${request.round}\n`);
  await writeTextFile(contextFile, buildClaudeContext({ request, sessionState, currentPaths: paths }));
  await markAgentPrepared(dataDir, request, paths, contextFile, agentState);

  return { kind: "input", path: inputPath(paths), output_file: outputPath(paths), status: "prepared" };
}
