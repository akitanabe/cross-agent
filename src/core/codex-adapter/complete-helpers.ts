import { extractThreadIdFromJsonl } from "./state.ts";
import { readOrCreateAgentState, readSessionState } from "./agent-state.ts";
import { failComplete } from "./failure.ts";
import type {
  AdapterRequestWithDataDir,
  ArtifactPathSet,
  CodexAgentState,
  CodexCompleteResult,
  CodexRunSpec,
} from "./types.ts";

export async function loadAgentStateForComplete(
  dataDir: string,
  runSpec: CodexRunSpec,
  request: AdapterRequestWithDataDir,
  paths: ArtifactPathSet,
): Promise<{ ok: true; agentState: CodexAgentState } | { ok: false; result: CodexCompleteResult }> {
  let agentState: CodexAgentState;
  try {
    const sessionState = await readSessionState(dataDir, runSpec.review_session_id);
    if (sessionState.review_session_id !== runSpec.review_session_id) {
      return {
        ok: false,
        result: await failComplete({
          request,
          agentState: null,
          paths,
          code: "state_file_invalid",
          message: "session state file review_session_id does not match run spec.",
        }),
      };
    }
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths,
        code: caught.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
        message:
          caught.code === "ENOENT"
            ? "session state file does not exist."
            : `state file is not valid JSON: ${caught.message}`,
      }),
    };
  }

  if (agentState.review_session_id !== runSpec.review_session_id || agentState.agent !== "codex") {
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths,
        code: "state_file_invalid",
        message: "Codex agent state file review_session_id or agent does not match run spec.",
      }),
    };
  }

  return { ok: true, agentState };
}

export async function resolveCompletedThreadId(
  runSpec: CodexRunSpec,
  request: AdapterRequestWithDataDir,
  paths: ArtifactPathSet,
  agentState: CodexAgentState,
  exitCode: number,
  eventLogText: string,
): Promise<{ ok: true; threadId: string } | { ok: false; result: CodexCompleteResult }> {
  if (runSpec.mode === "resume") {
    return { ok: true, threadId: runSpec.thread_id as string };
  }

  const threadId = extractThreadIdFromJsonl(eventLogText);
  if (threadId) return { ok: true, threadId };

  return {
    ok: false,
    result: await failComplete({
      request,
      agentState,
      paths,
      code: "codex_thread_id_missing",
      message: "thread.started event with thread_id was not found.",
      exitCode,
      extraDiagnostics: [
        `- mode: initial`,
        runSpec.decision_reason ? `- decision_reason: ${runSpec.decision_reason}` : null,
        runSpec.previous_thread_id ? `- previous_thread_id: ${runSpec.previous_thread_id}` : null,
        runSpec.previous_target_root ? `- previous_target_root: ${runSpec.previous_target_root}` : null,
      ],
    }),
  };
}
