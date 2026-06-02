import { mkdir } from "node:fs/promises";

import { isSafeRoundNumber } from "../shared/adapter-envelope.ts";
import { normalizePath } from "../shared/path-utils.ts";
import { readOrCreateAgentState, readSessionState, markAgentPrepared } from "./agent-state.ts";
import { failPrepare } from "./workflow-failure.ts";
import { artifactDirFor, artifactPaths, makeError, makeResponse, validateRequest, writeJsonAtomic } from "./state.ts";
import { makeCodexRunSpec } from "./workflow-run-spec.ts";
import type { AdapterRequestInput, CodexPrepareOptions, CodexPrepareResult, SessionState } from "./types.ts";
import { normalizeRequest, runPath } from "./workflow-common.ts";

export async function prepareCodexRun(
  request: AdapterRequestInput,
  options: CodexPrepareOptions = {},
): Promise<CodexPrepareResult> {
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
  // validateRequest より前に path を作るため、不正な round は filename に混ぜず "unknown" に落とす。
  const pathRound = isSafeRoundNumber(request.round) ? request.round : "unknown";
  const paths = artifactPaths(artifactDir, pathRound, request.agent_id ?? "unknown");
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
    const nodeError = error as NodeJS.ErrnoException;
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: nodeError.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message:
        nodeError.code === "ENOENT"
          ? "session state file does not exist."
          : `session state file is not valid JSON: ${nodeError.message}`,
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

  let agentState;
  try {
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error as Error;
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: `Codex agent state file is not valid JSON: ${caught.message}`,
    });
  }

  if (agentState.review_session_id !== request.review_session_id || agentState.agent_id !== request.agent_id) {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Codex agent state file review_session_id or agent_id does not match request.",
    });
  }

  const runSpec = makeCodexRunSpec(request, paths, agentState);
  await writeJsonAtomic(paths.runFile, runSpec);
  await markAgentPrepared(dataDir, request, paths, agentState);

  return { kind: "run", path: runPath(paths), status: "prepared" };
}
