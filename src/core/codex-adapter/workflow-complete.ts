import { readFile } from "node:fs/promises";

import { normalizePath } from "../shared/path-utils.ts";
import { markAgentCompleted } from "./agent-state.ts";
import { loadAgentStateForComplete, resolveCompletedThreadId } from "./workflow-complete-helpers.ts";
import { appendCompletionDiagnostic, completedArtifacts } from "./workflow-completion-artifacts.ts";
import { failComplete } from "./workflow-failure.ts";
import { makeResponse, pathExists, writeJsonAtomic } from "./state.ts";
import { loadRunSpecForComplete, mismatchedRunSpecPath, readCodexExit } from "./workflow-run-spec.ts";
import type { CodexCompleteResult, CodexExitResult, CodexPrepareOptions, CodexRunSpecMode } from "./types.ts";
import { responsePath } from "./workflow-common.ts";

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
