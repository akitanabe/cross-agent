import { dirname } from "node:path";

import { normalizePath } from "../shared/path-utils.ts";
import { artifactDirFor, artifactPaths, effortForReviewDepth, readJson, shouldStartNewSession } from "./state.ts";
import type {
  AdapterRequestInput,
  AdapterRequestWithDataDir,
  ArtifactPathSet,
  CodexAgentState,
  CodexCompleteResult,
  CodexExitResult,
  CodexRunSpec,
} from "./types.ts";
import { isObject } from "./workflow-common.ts";
import { failComplete } from "./workflow-failure.ts";

type LoadedRunSpec = {
  runSpec: CodexRunSpec;
  request: AdapterRequestWithDataDir;
  paths: ArtifactPathSet;
};

type LoadRunSpecResult = { ok: true; value: LoadedRunSpec } | { ok: false; result: CodexCompleteResult };

export function makeRequestFromRunSpec(runSpec: CodexRunSpec, dataDir: string | null): AdapterRequestWithDataDir {
  return {
    contract_version: 2,
    review_session_id: runSpec.review_session_id,
    agent_id: runSpec.agent_id,
    adapter: "codex",
    round: runSpec.round,
    round_kind: "unknown",
    target_root: runSpec.target_root,
    prompt_file: runSpec.prompt_file,
    context_file: null,
    target_files: [],
    focus_question: null,
    options: { review_depth: "medium", timeout_seconds: null },
    data_dir: dataDir,
  };
}

function roundFromRunFile(runFile: string): number {
  const match = /round-(\d+)-([A-Za-z0-9._-]+)-run\.json$/.exec(runFile.replaceAll("\\", "/"));
  return match ? Number(match[1]) : 0;
}

function makeFallbackRequestForRunSpec(
  value: unknown,
  runFile: string,
  dataDir: string | null,
): AdapterRequestWithDataDir {
  const object = isObject(value) ? value : {};
  const reviewSessionId =
    typeof object.review_session_id === "string" && object.review_session_id ? object.review_session_id : "unknown";
  const round = Number.isSafeInteger(object.round) ? (object.round as number) : roundFromRunFile(runFile);
  return {
    contract_version: 2,
    review_session_id: reviewSessionId,
    agent_id: typeof object.agent_id === "string" && object.agent_id ? object.agent_id : agentIdFromRunFile(runFile),
    adapter: "codex",
    round,
    round_kind: "unknown",
    target_root: typeof object.target_root === "string" ? object.target_root : "unknown",
    prompt_file: typeof object.prompt_file === "string" ? object.prompt_file : "unknown",
    context_file: null,
    target_files: [],
    focus_question: null,
    options: { review_depth: "medium", timeout_seconds: null },
    data_dir: dataDir,
  };
}

function fallbackPathsForRunSpec(value: unknown, runFile: string, dataDir: string): ArtifactPathSet {
  const object = isObject(value) ? value : {};
  const round = Number.isSafeInteger(object.round) ? (object.round as number) : roundFromRunFile(runFile);
  if (typeof object.review_session_id === "string" && object.review_session_id) {
    return artifactPaths(artifactDirFor(dataDir, object.review_session_id), round, agentIdFromRunFile(runFile));
  }
  return artifactPaths(dirname(runFile), round, agentIdFromRunFile(runFile));
}

function validateRunSpec(value: unknown): { runSpec: CodexRunSpec | null; message: string | null } {
  if (!isObject(value)) return { runSpec: null, message: "codex run spec must be an object." };
  if (value.schema_version !== 1) return { runSpec: null, message: "schema_version must be 1." };
  if (value.kind !== "codex_exec") return { runSpec: null, message: 'kind must be "codex_exec".' };
  if (value.mode !== "initial" && value.mode !== "resume") {
    return { runSpec: null, message: 'mode must be "initial" or "resume".' };
  }
  const requiredStrings = [
    "review_session_id",
    "agent_id",
    "adapter",
    "target_root",
    "prompt_file",
    "output_file",
    "event_log",
    "exit_file",
    "model_reasoning_effort",
  ];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key] === "") {
      return { runSpec: null, message: `${key} must be a non-empty string.` };
    }
  }
  if (!Number.isSafeInteger(value.round)) return { runSpec: null, message: "round must be an integer." };
  if (value.adapter !== "codex") return { runSpec: null, message: 'adapter must be "codex".' };
  if (value.mode === "resume" && (typeof value.thread_id !== "string" || value.thread_id === "")) {
    return { runSpec: null, message: "thread_id must be a non-empty string in resume mode." };
  }
  if (value.mode === "initial" && value.thread_id !== null) {
    return { runSpec: null, message: "thread_id must be null in initial mode." };
  }
  if (!["medium", "high", "xhigh"].includes(value.model_reasoning_effort as string)) {
    return { runSpec: null, message: "model_reasoning_effort is not allowed." };
  }
  if (value.skip_git_repo_check !== true) {
    return { runSpec: null, message: "skip_git_repo_check must be true." };
  }
  return { runSpec: value as CodexRunSpec, message: null };
}

export function makeCodexRunSpec(
  request: AdapterRequestInput,
  paths: ArtifactPathSet,
  agentState: CodexAgentState,
): CodexRunSpec {
  const { effort, warning } = effortForReviewDepth(request.options?.review_depth);
  const decision = shouldStartNewSession(agentState, request.target_root);
  return {
    schema_version: 1,
    kind: "codex_exec",
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "codex",
    round: request.round,
    mode: decision.startNew ? "initial" : "resume",
    target_root: normalizePath(request.target_root) as string,
    thread_id: decision.startNew ? null : agentState.thread_id,
    prompt_file: normalizePath(request.prompt_file) as string,
    output_file: normalizePath(paths.outputFile) as string,
    event_log: normalizePath(paths.eventLog) as string,
    exit_file: normalizePath(paths.exitFile) as string,
    model_reasoning_effort: effort,
    skip_git_repo_check: true,
    decision_reason: decision.reason,
    previous_thread_id: agentState.thread_id ?? null,
    previous_target_root: agentState.target_root ?? null,
    warning,
  };
}

export async function readCodexExit(exitFile: string): Promise<CodexExitResult> {
  const exitResult = await readJson<unknown>(exitFile);
  if (!isObject(exitResult) || !Number.isInteger(exitResult.code)) {
    throw new Error("codex exit file must contain numeric code.");
  }
  return { code: exitResult.code as number };
}

export async function loadRunSpecForComplete(runFile: string, dataDir: string): Promise<LoadRunSpecResult> {
  let rawRunSpec: unknown;
  try {
    rawRunSpec = await readJson<unknown>(runFile);
  } catch (error) {
    const caught = error as Error;
    const request = makeFallbackRequestForRunSpec(null, runFile, dataDir);
    const paths = fallbackPathsForRunSpec(null, runFile, dataDir);
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths,
        code: "codex_run_spec_invalid",
        message: `codex run spec is missing or invalid: ${caught.message}`,
      }),
    };
  }

  const { runSpec, message } = validateRunSpec(rawRunSpec);
  if (!runSpec) {
    const request = makeFallbackRequestForRunSpec(rawRunSpec, runFile, dataDir);
    const paths = fallbackPathsForRunSpec(rawRunSpec, runFile, dataDir);
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths,
        code: "codex_run_spec_invalid",
        message: message ?? "invalid run spec.",
      }),
    };
  }

  const artifactDir = artifactDirFor(dataDir, runSpec.review_session_id);
  const paths = artifactPaths(artifactDir, runSpec.round, runSpec.agent_id);
  return { ok: true, value: { runSpec, request: makeRequestFromRunSpec(runSpec, dataDir), paths } };
}

export function mismatchedRunSpecPath(runSpec: CodexRunSpec, paths: ArtifactPathSet): string | null {
  const expectedPaths = {
    output_file: paths.outputFile,
    event_log: paths.eventLog,
    exit_file: paths.exitFile,
  };
  for (const [field, expectedPath] of Object.entries(expectedPaths)) {
    if (normalizePath(runSpec[field as keyof typeof expectedPaths]) !== normalizePath(expectedPath)) {
      return field;
    }
  }
  return null;
}
function agentIdFromRunFile(runFile: string): string {
  const match = /round-\d+-([A-Za-z0-9._-]+)-run\.json$/.exec(runFile.replaceAll("\\", "/"));
  return match ? match[1] : "codex";
}
