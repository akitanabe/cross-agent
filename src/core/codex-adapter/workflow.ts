import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AdapterResponseArtifact, AdapterResponseEnvelope } from "../shared/adapter-envelope.ts";
import { normalizePath, normalizePathList } from "../shared/path-utils.ts";
import {
  agentStateFileFor,
  artifact,
  artifactDirFor,
  artifactPaths,
  effortForReviewDepth,
  extractThreadIdFromJsonl,
  makeError,
  makeResponse,
  nowIso,
  pathExists,
  readJson,
  readJsonIfExists,
  sessionStateFileFor,
  shouldStartNewSession,
  validateRequest,
  writeDiagnostic,
  writeJsonAtomic,
} from "./state.ts";
import type {
  AdapterRequestInput,
  AdapterRequestWithDataDir,
  ArtifactPathSet,
  CodexAgentState,
  CodexExitResult,
  CodexPrepareOptions,
  CodexRunSpec,
  CodexRunSpecMode,
  SessionState,
} from "./types.ts";

export type CodexPrepareResult =
  | { kind: "run"; path: string; status: "prepared" }
  | { kind: "response"; path: string; response: AdapterResponseEnvelope };

export type CodexCompleteResult = {
  path: string;
  response: AdapterResponseEnvelope;
};

// agent state の artifacts に adapter 生成 artifact を追記する。
async function appendAgentArtifacts(agentState: CodexAgentState, artifacts: AdapterResponseArtifact[]): Promise<void> {
  agentState.artifacts ??= [];
  agentState.artifacts.push(...artifacts);
}

function normalizeRequest(request: AdapterRequestInput): AdapterRequestInput {
  return {
    ...request,
    target_root: normalizePath(request.target_root),
    prompt_file: normalizePath(request.prompt_file),
    context_file: normalizePath(request.context_file),
    target_files: normalizePathList(request.target_files),
  };
}

function makeRequestFromRunSpec(runSpec: CodexRunSpec, dataDir: string | null): AdapterRequestWithDataDir {
  return {
    contract_version: 1,
    review_session_id: runSpec.review_session_id,
    agent: "codex",
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
  const match = /round-(\d+)-codex-run\.json$/.exec(runFile.replaceAll("\\", "/"));
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
    contract_version: 1,
    review_session_id: reviewSessionId,
    agent: "codex",
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
    return artifactPaths(artifactDirFor(dataDir, object.review_session_id), round);
  }
  return artifactPaths(dirname(runFile), round);
}

function responsePath(paths: ArtifactPathSet): string {
  return normalizePath(paths.responseFile) as string;
}

function runPath(paths: ArtifactPathSet): string {
  return normalizePath(paths.runFile) as string;
}

// 失敗時の diagnostic、response envelope、可能なら agent state 更新をまとめて行う。
async function handleFailure({
  request,
  agentState,
  paths,
  code,
  message,
  exitCode = null,
  extraDiagnostics = [],
}: {
  request: AdapterRequestWithDataDir;
  agentState: CodexAgentState | null;
  paths: ArtifactPathSet;
  code: string;
  message: string;
  exitCode?: number | null;
  extraDiagnostics?: Array<string | null | undefined>;
}): Promise<AdapterResponseEnvelope> {
  // 失敗時も response envelope を返し、agent state が有効なら復旧可能な診断を追記する。
  const diagnosticArtifact = artifact(paths.diagnosticFile, "diagnostic", request.round);
  const error = makeError(code, message, paths.diagnosticFile);
  const response = makeResponse(request, "failed", null, [diagnosticArtifact], error);

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

  if (agentState) {
    const agentStateFile = agentStateFileFor(request.data_dir ?? ".", request.review_session_id);
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
    await appendAgentArtifacts(agentState, [diagnosticArtifact]);
    agentState.errors ??= [];
    agentState.errors.push({ ...error, agent: "codex", round: request.round, created_at: nowIso() });
    await mkdir(dirname(agentStateFile), { recursive: true });
    await writeJsonAtomic(agentStateFile, agentState);
  }

  await writeJsonAtomic(paths.responseFile, response);
  return response;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function readSessionState(dataDir: string, reviewSessionId: string): Promise<SessionState> {
  return await readJson<SessionState>(sessionStateFileFor(dataDir, reviewSessionId));
}

async function readOrCreateAgentState(dataDir: string, request: AdapterRequestInput): Promise<CodexAgentState> {
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
    const response = await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: validationError.code,
      message: validationError.message,
    });
    return { kind: "response", path: responsePath(paths), response };
  }

  let sessionState: SessionState;
  try {
    sessionState = await readSessionState(dataDir, request.review_session_id);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    const response = await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: nodeError.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message:
        nodeError.code === "ENOENT"
          ? "session state file does not exist."
          : `session state file is not valid JSON: ${nodeError.message}`,
    });
    return { kind: "response", path: responsePath(paths), response };
  }

  if (sessionState.review_session_id !== request.review_session_id) {
    const response = await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "session state file review_session_id does not match request.",
    });
    return { kind: "response", path: responsePath(paths), response };
  }

  let agentState: CodexAgentState;
  try {
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error as Error;
    const response = await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: `Codex agent state file is not valid JSON: ${caught.message}`,
    });
    return { kind: "response", path: responsePath(paths), response };
  }

  if (agentState.review_session_id !== request.review_session_id || agentState.agent !== "codex") {
    const response = await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Codex agent state file review_session_id or agent does not match request.",
    });
    return { kind: "response", path: responsePath(paths), response };
  }

  const { effort, warning } = effortForReviewDepth(request.options?.review_depth);
  const decision = shouldStartNewSession(agentState, request.target_root);
  const runSpec: CodexRunSpec = {
    schema_version: 1,
    kind: "codex_exec",
    review_session_id: request.review_session_id,
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

  await writeJsonAtomic(paths.runFile, runSpec);

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
  await mkdir(dirname(agentStateFileFor(dataDir, request.review_session_id)), { recursive: true });
  await writeJsonAtomic(agentStateFileFor(dataDir, request.review_session_id), agentState);

  return { kind: "run", path: runPath(paths), status: "prepared" };
}

async function readCodexExit(exitFile: string): Promise<CodexExitResult> {
  const exitResult = await readJson<unknown>(exitFile);
  if (!isObject(exitResult) || !Number.isInteger(exitResult.code)) {
    throw new Error("codex exit file must contain numeric code.");
  }
  return { code: exitResult.code as number };
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

  let rawRunSpec: unknown;
  try {
    rawRunSpec = await readJson<unknown>(runFile);
  } catch (error) {
    const caught = error as Error;
    const request = makeFallbackRequestForRunSpec(null, runFile, dataDir);
    const paths = fallbackPathsForRunSpec(null, runFile, dataDir);
    const response = await handleFailure({
      request,
      agentState: null,
      paths,
      code: "codex_run_spec_invalid",
      message: `codex run spec is missing or invalid: ${caught.message}`,
    });
    return { path: responsePath(paths), response };
  }

  const { runSpec, message } = validateRunSpec(rawRunSpec);
  if (!runSpec) {
    const request = makeFallbackRequestForRunSpec(rawRunSpec, runFile, dataDir);
    const paths = fallbackPathsForRunSpec(rawRunSpec, runFile, dataDir);
    const response = await handleFailure({
      request,
      agentState: null,
      paths,
      code: "codex_run_spec_invalid",
      message: message ?? "invalid run spec.",
    });
    return { path: responsePath(paths), response };
  }

  const artifactDir = artifactDirFor(dataDir, runSpec.review_session_id);
  const paths = artifactPaths(artifactDir, runSpec.round);
  const request = makeRequestFromRunSpec(runSpec, dataDir);

  const expectedPaths = {
    output_file: paths.outputFile,
    event_log: paths.eventLog,
    exit_file: paths.exitFile,
  };
  for (const [field, expectedPath] of Object.entries(expectedPaths)) {
    if (normalizePath(runSpec[field as keyof typeof expectedPaths]) !== normalizePath(expectedPath)) {
      const response = await handleFailure({
        request,
        agentState: null,
        paths,
        code: "codex_run_spec_invalid",
        message: `${field} does not match derived artifact path.`,
      });
      return { path: responsePath(paths), response };
    }
  }

  let agentState: CodexAgentState;
  try {
    const sessionState = await readSessionState(dataDir, runSpec.review_session_id);
    if (sessionState.review_session_id !== runSpec.review_session_id) {
      const response = await handleFailure({
        request,
        agentState: null,
        paths,
        code: "state_file_invalid",
        message: "session state file review_session_id does not match run spec.",
      });
      return { path: responsePath(paths), response };
    }
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    const response = await handleFailure({
      request,
      agentState: null,
      paths,
      code: caught.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message:
        caught.code === "ENOENT"
          ? "session state file does not exist."
          : `state file is not valid JSON: ${caught.message}`,
    });
    return { path: responsePath(paths), response };
  }

  if (agentState.review_session_id !== runSpec.review_session_id || agentState.agent !== "codex") {
    const response = await handleFailure({
      request,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Codex agent state file review_session_id or agent does not match run spec.",
    });
    return { path: responsePath(paths), response };
  }

  let exitResult: CodexExitResult;
  try {
    exitResult = await readCodexExit(runSpec.exit_file);
  } catch (error) {
    const caught = error as Error;
    const response = await handleFailure({
      request,
      agentState,
      paths,
      code: "codex_exit_missing",
      message: `codex exit file is missing or invalid: ${caught.message}`,
    });
    return { path: responsePath(paths), response };
  }

  const eventLogText = (await pathExists(runSpec.event_log)) ? await readFile(runSpec.event_log, "utf8") : "";
  if (exitResult.code !== 0) {
    const mode: CodexRunSpecMode = runSpec.mode;
    const response = await handleFailure({
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
    return { path: responsePath(paths), response };
  }

  let threadId = runSpec.thread_id;
  if (runSpec.mode === "initial") {
    threadId = extractThreadIdFromJsonl(eventLogText);
    if (!threadId) {
      const response = await handleFailure({
        request,
        agentState,
        paths,
        code: "codex_thread_id_missing",
        message: "thread.started event with thread_id was not found.",
        exitCode: exitResult.code,
        extraDiagnostics: [
          `- mode: initial`,
          runSpec.decision_reason ? `- decision_reason: ${runSpec.decision_reason}` : null,
          runSpec.previous_thread_id ? `- previous_thread_id: ${runSpec.previous_thread_id}` : null,
          runSpec.previous_target_root ? `- previous_target_root: ${runSpec.previous_target_root}` : null,
        ],
      });
      return { path: responsePath(paths), response };
    }
  }

  if (!(await pathExists(runSpec.output_file))) {
    const response = await handleFailure({
      request,
      agentState,
      paths,
      code: "codex_output_missing",
      message: "codex output file was not created.",
      exitCode: exitResult.code,
    });
    return { path: responsePath(paths), response };
  }

  const artifacts = [
    artifact(paths.runFile, "run_spec", runSpec.round),
    artifact(runSpec.output_file, "agent_output", runSpec.round),
    artifact(runSpec.event_log, "event_log", runSpec.round),
    artifact(runSpec.exit_file, "exit_status", runSpec.round),
  ];

  if (runSpec.warning || runSpec.decision_reason === "target_root_changed") {
    await writeDiagnostic(paths.diagnosticFile, [
      `# Codex adapter diagnostic`,
      ``,
      `- status: completed`,
      `- mode: ${runSpec.mode}`,
      runSpec.decision_reason ? `- decision_reason: ${runSpec.decision_reason}` : null,
      `- thread_id: ${threadId}`,
      runSpec.warning ? `- warning: ${runSpec.warning}` : null,
      runSpec.decision_reason === "target_root_changed" ? `- warning: target_root_changed` : null,
      runSpec.previous_thread_id ? `- previous_thread_id: ${runSpec.previous_thread_id}` : null,
      runSpec.previous_target_root ? `- previous_target_root: ${runSpec.previous_target_root}` : null,
      `- target_root: ${runSpec.target_root}`,
    ]);
    artifacts.push(artifact(paths.diagnosticFile, "diagnostic", runSpec.round));
  }

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
  await mkdir(dirname(agentStateFileFor(dataDir, runSpec.review_session_id)), { recursive: true });
  await writeJsonAtomic(agentStateFileFor(dataDir, runSpec.review_session_id), agentState);

  const response = makeResponse(request, "completed", runSpec.output_file, artifacts, null);
  await writeJsonAtomic(paths.responseFile, response);
  return { path: responsePath(paths), response };
}
