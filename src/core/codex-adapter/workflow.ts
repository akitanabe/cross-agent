import { mkdir, readFile } from "node:fs/promises";

import { normalizePath } from "../shared/path-utils.ts";
import { readOrCreateAgentState, readSessionState, markAgentCompleted, markAgentPrepared } from "./agent-state.ts";
import { loadAgentStateForComplete, resolveCompletedThreadId } from "./complete-helpers.ts";
import { appendCompletionDiagnostic, completedArtifacts } from "./completion-artifacts.ts";
import { failComplete, failPrepare } from "./failure.ts";
import {
  artifactDirFor,
  artifactPaths,
  makeError,
  makeResponse,
  pathExists,
  validateRequest,
  writeJsonAtomic,
} from "./state.ts";
import { loadRunSpecForComplete, makeCodexRunSpec, mismatchedRunSpecPath, readCodexExit } from "./run-spec.ts";
import type {
  AdapterRequestInput,
  CodexCompleteResult,
  CodexExitResult,
  CodexPrepareOptions,
  CodexPrepareResult,
  CodexRunSpecMode,
  SessionState,
} from "./types.ts";
import { normalizeRequest, responsePath, runPath } from "./workflow-common.ts";

// request を検証し、Codex CLI 実行用の run spec を作成する。Codex CLI は起動しない。
export async function prepareCodexRun(
  request: AdapterRequestInput,
  options: CodexPrepareOptions = {},
): Promise<CodexPrepareResult> {
  const dataDir = options.dataDir ? (normalizePath(options.dataDir) as string) : null;
  request = normalizeRequest(request);

  if (!dataDir) {
    const response = makeResponse(
      { ...request, data_dir: dataDir },
      "failed",
      null,
      [],
      makeError(
        "invalid_request_envelope",
        '--data-dir is required. In plugin context, pass `--data-dir "${CLAUDE_PLUGIN_DATA}"` ' +
          "(Claude Code substitutes this in skill content).",
      ),
    );
    return { kind: "response", path: "", response };
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

  if (agentState.review_session_id !== request.review_session_id || agentState.agent !== "codex") {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Codex agent state file review_session_id or agent does not match request.",
    });
  }

  const runSpec = makeCodexRunSpec(request, paths, agentState);
  await writeJsonAtomic(paths.runFile, runSpec);
  await markAgentPrepared(dataDir, request, paths, agentState);

  return { kind: "run", path: runPath(paths), status: "prepared" };
}

// Codex CLI 実行後の artifact を検証し、state と response envelope を確定する。
export async function completeCodexRun(
  runFile: string,
  options: CodexPrepareOptions = {},
): Promise<CodexCompleteResult> {
  const dataDir = options.dataDir ? (normalizePath(options.dataDir) as string) : null;
  if (!dataDir) {
    throw new Error("--data-dir is required.");
  }

  const loaded = await loadRunSpecForComplete(runFile, dataDir);
  if (!loaded.ok) return loaded.result;
  const { runSpec, request, paths } = loaded.value;

  const mismatchedPath = mismatchedRunSpecPath(runSpec, paths);
  if (mismatchedPath) {
    return failComplete({
      request,
      agentState: null,
      paths,
      code: "codex_run_spec_invalid",
      message: `${mismatchedPath} does not match derived artifact path.`,
    });
  }

  const loadedAgentState = await loadAgentStateForComplete(dataDir, runSpec, request, paths);
  if (!loadedAgentState.ok) return loadedAgentState.result;
  const { agentState } = loadedAgentState;

  let exitResult: CodexExitResult;
  try {
    exitResult = await readCodexExit(runSpec.exit_file);
  } catch (error) {
    const caught = error as Error;
    return failComplete({
      request,
      agentState,
      paths,
      code: "codex_exit_missing",
      message: `codex exit file is missing or invalid: ${caught.message}`,
    });
  }

  const eventLogText = (await pathExists(runSpec.event_log)) ? await readFile(runSpec.event_log, "utf8") : "";
  if (exitResult.code !== 0) {
    const mode: CodexRunSpecMode = runSpec.mode;
    return failComplete({
      request,
      agentState,
      paths,
      code: mode === "initial" ? "codex_exec_failed" : "codex_resume_failed",
      message: mode === "initial" ? "codex exec failed." : "codex exec resume failed.",
      exitCode: exitResult.code,
      extraDiagnostics: [
        `- mode: ${mode}`,
        runSpec.decision_reason ? `- decision_reason: ${runSpec.decision_reason}` : null,
        runSpec.warning ? `- warning: ${runSpec.warning}` : null,
      ],
    });
  }

  const completedThread = await resolveCompletedThreadId(
    runSpec,
    request,
    paths,
    agentState,
    exitResult.code,
    eventLogText,
  );
  if (!completedThread.ok) return completedThread.result;
  const { threadId } = completedThread;

  if (!(await pathExists(runSpec.output_file))) {
    return failComplete({
      request,
      agentState,
      paths,
      code: "codex_output_missing",
      message: "codex output file was not created.",
      exitCode: exitResult.code,
    });
  }

  const artifacts = completedArtifacts(runSpec, paths);
  await appendCompletionDiagnostic(runSpec, paths, threadId, artifacts);
  await markAgentCompleted({ dataDir, runSpec, paths, agentState, threadId, artifacts });

  const response = makeResponse(request, "completed", runSpec.output_file, artifacts, null);
  await writeJsonAtomic(paths.responseFile, response);
  return { path: responsePath(paths), response };
}
