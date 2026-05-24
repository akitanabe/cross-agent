import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AdapterResponseArtifact, AdapterResponseEnvelope } from "./adapter-envelope.ts";
import { normalizePath, normalizePathList } from "./path-utils.ts";
import { runCodex } from "./codex-adapter-process.ts";
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
} from "./codex-adapter-state.ts";
import type {
  AdapterRequestInput,
  AdapterRequestWithDataDir,
  ArtifactPathSet,
  CodexAgentState,
  CodexCommandResult,
  CodexRunOptions,
  SessionState,
} from "./codex-adapter-types.ts";

// agent state の artifacts に adapter 生成 artifact を追記する。
async function appendAgentArtifacts(agentState: CodexAgentState, artifacts: AdapterResponseArtifact[]): Promise<void> {
  agentState.artifacts ??= [];
  agentState.artifacts.push(...artifacts);
}

// 失敗時の diagnostic、response envelope、可能なら agent state 更新をまとめて行う。
async function handleFailure({
  request,
  agentState,
  paths,
  code,
  message,
  commandResult = null,
  extraDiagnostics = [],
}: {
  request: AdapterRequestWithDataDir;
  agentState: CodexAgentState | null;
  paths: ArtifactPathSet;
  code: string;
  message: string;
  commandResult?: CodexCommandResult | null;
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
    commandResult ? `- exit_code: ${commandResult.code}` : null,
    commandResult?.signal ? `- signal: ${commandResult.signal}` : null,
    commandResult?.error ? `- spawn_error: ${commandResult.error.message}` : null,
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
      last_output_file: agentState.last_output_file ?? null,
      last_event_log: paths.eventLog,
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

// codex-adapter の主処理。request を受け、Codex 実行、state 更新、response 生成まで行う。
export async function runAdapter(
  request: AdapterRequestInput,
  options: CodexRunOptions = {},
): Promise<AdapterResponseEnvelope> {
  // adapter は自分で導出する Codex agent state file だけを所有する。
  // rounds と全体 status は cross-agent の所有物。
  const codexBin = options.codexBin ?? "codex";
  const codexBinArgs = options.codexBinArgs ?? [];
  const launcher = options.launcher ?? null;
  // data_dir は --data-dir フラグでの必須入力。plugin 文脈では SKILL.md の例の通り
  // ${CLAUDE_PLUGIN_DATA} を渡す (skill content 内で Claude Code が絶対パスに展開する)。
  // Bash tool に env var として export されないことが公式仕様なので、env var フォールバックは
  // 直接 CLI から呼ぶケース以外では発火しないデッドコードになる。利用源を一本化する。
  const dataDir = options.dataDir ? normalizePath(options.dataDir) : null;
  // 環境差異（MSYS drive 表記・区切り文字）を入口で吸収し、以降は正規化済みパスで扱う。
  request = {
    ...request,
    target_root: normalizePath(request.target_root),
    prompt_file: normalizePath(request.prompt_file),
    context_file: normalizePath(request.context_file),
    target_files: normalizePathList(request.target_files),
  };
  const requestWithDataDir = { ...request, data_dir: dataDir };
  const artifactDir = artifactDirFor(dataDir ?? ".", request.review_session_id ?? "unknown");
  const paths = artifactPaths(artifactDir, request.round ?? "unknown");
  const sessionStateFile = sessionStateFileFor(dataDir ?? ".", request.review_session_id ?? "unknown");
  const agentStateFile = agentStateFileFor(dataDir ?? ".", request.review_session_id ?? "unknown");

  if (!dataDir) {
    return makeResponse(
      requestWithDataDir,
      "failed",
      null,
      [],
      makeError(
        "invalid_request_envelope",
        "--data-dir is required. In plugin context, pass `--data-dir \"${CLAUDE_PLUGIN_DATA}\"` " +
          "(Claude Code substitutes this in skill content).",
      ),
    );
  }

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
    return response;
  }

  let sessionState: SessionState;
  try {
    sessionState = await readJson<SessionState>(sessionStateFile);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return await handleFailure({
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
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "session state file review_session_id does not match request.",
    });
  }

  let agentState: CodexAgentState;
  try {
    agentState =
      (await readJsonIfExists<CodexAgentState>(agentStateFile)) ?? {
        schema_version: 1,
        review_session_id: request.review_session_id,
        agent: "codex",
        status: "pending",
        thread_id: null,
        target_root: null,
        last_output_file: null,
        last_event_log: null,
        last_error: null,
        artifacts: [],
        errors: [],
      };
  } catch (error) {
    const caught = error as Error;
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: `Codex agent state file is not valid JSON: ${caught.message}`,
    });
  }

  if (agentState.review_session_id !== request.review_session_id || agentState.agent !== "codex") {
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Codex agent state file review_session_id or agent does not match request.",
    });
  }

  const promptText = await readFile(request.prompt_file, "utf8");
  const { effort, warning } = effortForReviewDepth(request.options?.review_depth);
  const existingAgentState = agentState;
  // thread と固定済み target_root の両方が一致する場合だけ resume する。
  const decision = shouldStartNewSession(existingAgentState, request.target_root);
  const oldThreadId = existingAgentState.thread_id ?? null;
  const oldTargetRoot = existingAgentState.target_root ?? null;
  const commandResult = await runCodex({
    codexBin,
    codexBinArgs,
    launcher,
    mode: decision.startNew ? "initial" : "resume",
    request,
    promptText,
    effort,
    outputFile: paths.outputFile,
    eventLog: paths.eventLog,
    threadId: existingAgentState.thread_id,
  });

  const eventLogText = (await pathExists(paths.eventLog)) ? await readFile(paths.eventLog, "utf8") : "";
  if (commandResult.error || commandResult.code !== 0) {
    return await handleFailure({
      request: requestWithDataDir,
      agentState,
      paths,
      code: decision.startNew ? "codex_exec_failed" : "codex_resume_failed",
      message: decision.startNew ? "codex exec failed." : "codex exec resume failed.",
      commandResult,
      extraDiagnostics: [
        `- mode: ${decision.startNew ? "initial" : "resume"}`,
        `- decision_reason: ${decision.reason}`,
        warning ? `- warning: ${warning}` : null,
      ],
    });
  }

  let threadId = existingAgentState.thread_id;
  if (decision.startNew) {
    // 新規 session では thread.started が必須。resume では既存 thread_id を維持する。
    threadId = extractThreadIdFromJsonl(eventLogText);
    if (!threadId) {
      return await handleFailure({
        request: requestWithDataDir,
        agentState,
        paths,
        code: "codex_thread_id_missing",
        message: "thread.started event with thread_id was not found.",
        commandResult,
        extraDiagnostics: [
          `- mode: initial`,
          `- decision_reason: ${decision.reason}`,
          oldThreadId ? `- previous_thread_id: ${oldThreadId}` : null,
          oldTargetRoot ? `- previous_target_root: ${oldTargetRoot}` : null,
        ],
      });
    }
  }

  if (!(await pathExists(paths.outputFile))) {
    return await handleFailure({
      request: requestWithDataDir,
      agentState,
      paths,
      code: "codex_output_missing",
      message: "codex output file was not created.",
      commandResult,
    });
  }

  const artifacts = [
    artifact(paths.outputFile, "agent_output", request.round),
    artifact(paths.eventLog, "event_log", request.round),
  ];

  if (warning || decision.reason === "target_root_changed") {
    // 成功時でも target_root 切り替えなど、後で追いたい診断は残す。
    await writeDiagnostic(paths.diagnosticFile, [
      `# Codex adapter diagnostic`,
      ``,
      `- status: completed`,
      `- mode: ${decision.startNew ? "initial" : "resume"}`,
      `- decision_reason: ${decision.reason}`,
      `- thread_id: ${threadId}`,
      warning ? `- warning: ${warning}` : null,
      decision.reason === "target_root_changed" ? `- warning: target_root_changed` : null,
      oldThreadId ? `- previous_thread_id: ${oldThreadId}` : null,
      oldTargetRoot ? `- previous_target_root: ${oldTargetRoot}` : null,
      `- target_root: ${request.target_root}`,
    ]);
    artifacts.push(artifact(paths.diagnosticFile, "diagnostic", request.round));
  }

  agentState.updated_at = nowIso();
  // Codex 所有 state を、最後に使えることが確認できた thread mapping へ更新する。
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent: "codex",
    status: "active",
    thread_id: threadId,
    target_root: request.target_root,
    last_output_file: paths.outputFile,
    last_event_log: paths.eventLog,
    last_error: null,
  });
  await appendAgentArtifacts(agentState, artifacts);
  await mkdir(dirname(agentStateFile), { recursive: true });
  await writeJsonAtomic(agentStateFile, agentState);

  const response = makeResponse(requestWithDataDir, "completed", paths.outputFile, artifacts, null);
  await writeJsonAtomic(paths.responseFile, response);
  return response;
}
