#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptionArgs } from "./cli-args.mjs";
import { normalizePath, normalizePathList } from "./path-utils.mjs";

const OWNER = "codex-adapter";

// cross-agent の抽象 review_depth を Codex CLI の reasoning effort に変換する。
export function effortForReviewDepth(reviewDepth) {
  if (reviewDepth === "low") return { effort: "medium", warning: null };
  if (reviewDepth === "medium") return { effort: "high", warning: null };
  if (reviewDepth === "high") return { effort: "xhigh", warning: null };
  return {
    effort: "high",
    warning: `Unknown review_depth "${reviewDepth ?? ""}". Falling back to high.`,
  };
}

// data directory から、この review session 用の artifact directory を導出する。
export function artifactDirFor(dataDir, reviewSessionId) {
  // plugin root へ書かないように、artifact は state store の隣に置く。
  return resolve(dataDir, "artifacts", reviewSessionId);
}

// data directory から、session state file を導出する。
export function sessionStateFileFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "sessions", `${reviewSessionId}.json`);
}

// data directory から、Codex 用の個別 agent state file を導出する。
export function agentStateFileFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "sessions", reviewSessionId, "agents", "codex.json");
}

// round 番号から Codex adapter が生成する artifact 群のパスを組み立てる。
export function artifactPaths(artifactDir, round) {
  return {
    outputFile: resolve(artifactDir, `round-${round}-codex-output.md`),
    eventLog: resolve(artifactDir, `round-${round}-codex-events.jsonl`),
    diagnosticFile: resolve(artifactDir, `round-${round}-codex-diagnostic.md`),
    responseFile: resolve(artifactDir, `round-${round}-codex-response.json`),
  };
}

// Codex の JSONL event stream から、新規 session の thread_id を抽出する。
export function extractThreadIdFromJsonl(text) {
  // Codex は人間向け診断を混ぜることがあるため、構造化 event だけを採用する。
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
        return event.thread_id;
      }
    } catch {
      // stderr を event log に混ぜる実装では、JSON ではない行も入りうる。
    }
  }
  return null;
}

// 保存済み Codex state と今回の target_root から、新規 session が必要か判定する。
export function shouldStartNewSession(agentState, targetRoot) {
  // Codex session は初回 cwd に固定されるため、target_root 変更時は新しい thread が必要。
  if (!agentState?.thread_id) {
    return { startNew: true, reason: "missing_thread_id" };
  }
  if (agentState.target_root !== targetRoot) {
    return { startNew: true, reason: "target_root_changed" };
  }
  return { startNew: false, reason: "resume" };
}

const optionArgs = {
  "--request": { field: "requestFile" },
  "-r": { field: "requestFile" },
  "--codex-bin": { field: "codexBin" },
  "--data-dir": { field: "dataDir" },
  "--launcher": {
    field: "launcher",
    // codex 起動を POSIX shell 経由で wrap する。空文字なら未指定扱い (直接 spawn) にする。
    parse: (value) => (value === "" ? null : value),
  },
};

// CLI 引数を、この runner が扱う option に変換する。
export function parseArgs(argv) {
  return parseOptionArgs(argv, optionArgs, {
    initialArgs: {
      requestFile: null,
      codexBin: "codex",
      dataDir: null,
      launcher: null,
    },
  });
}

// CLI の使い方テキストを返す。
function usage() {
  return `Usage:
  node scripts/codex-adapter-runner.mjs --request <request-envelope.json> [--codex-bin codex] [--data-dir <CLAUDE_PLUGIN_DATA>] [--launcher <shell>]

Reads a cross-agent adapter request envelope, executes Codex CLI, updates state JSON,
and writes the adapter response envelope to the artifact directory. stdout contains only
the response envelope file path.

--launcher wraps codex via a POSIX shell (e.g. \`--launcher bash\`). Use this when the
codex binary on the current platform is a shell shim that cannot be spawned directly,
e.g. on Windows where codex is a Git Bash script. The agent decides per-platform whether
to pass --launcher; the runner has no platform branch.`;
}

// 指定パスが存在するかを boolean で返す。
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// JSON ファイルを読み込み、オブジェクトとして返す。
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

// JSON ファイルがあれば読み込み、なければ null を返す。
async function readJsonIfExists(filePath) {
  return (await pathExists(filePath)) ? await readJson(filePath) : null;
}

// JSON を一時ファイルへ書いてから rename し、対象ファイルを atomic に更新する。
async function writeJsonAtomic(filePath, value) {
  // 書き込み途中で落ちても state file が半端に壊れないようにする。
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

// state や artifact に記録する現在時刻を ISO 文字列で返す。
function nowIso() {
  return new Date().toISOString();
}

// state に append する artifact metadata を作る。
function artifact(path, kind, round, agent = "codex") {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent,
    created_at: nowIso(),
    temporary: false,
  };
}

// response envelope と state に記録する recoverable error を作る。
function makeError(code, message, detailsFile = null) {
  return {
    code,
    message,
    recoverable: true,
    details_file: detailsFile,
  };
}

// cross-agent へ返す adapter response envelope を作る。
// adapter 境界の契約として、path フィールドは forward slash に統一する。
// Windows の `\` をそのまま JSON に乗せると、後段の `JSON.parse` が `\U` 等で落ちる。
function makeResponse(request, status, outputFile, artifacts, error) {
  const normalizedArtifacts = (artifacts ?? []).map((entry) =>
    entry?.path ? { ...entry, path: normalizePath(entry.path) } : entry,
  );
  const normalizedError =
    error && error.details_file ? { ...error, details_file: normalizePath(error.details_file) } : error;
  return {
    contract_version: 1,
    review_session_id: request?.review_session_id ?? null,
    agent: "codex",
    round: request?.round ?? null,
    status,
    output_file: outputFile ? normalizePath(outputFile) : outputFile,
    artifacts: normalizedArtifacts,
    error: normalizedError,
  };
}

// 診断情報を Markdown ファイルとして保存する。
async function writeDiagnostic(filePath, lines) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.filter(Boolean).join("\n")}\n`, "utf8");
}

// request envelope と参照先ファイル/ディレクトリが実行可能な状態か検証する。
async function validateRequest(request) {
  // ここでは adapter 境界だけを検証する。レビュー判断の意味解釈は cross-agent の責務。
  const required = [
    "contract_version",
    "review_session_id",
    "agent",
    "round",
    "round_kind",
    "target_root",
    "prompt_file",
    "options",
  ];
  const missing = required.filter((key) => request[key] === undefined || request[key] === null || request[key] === "");
  if (missing.length) {
    return makeError("invalid_request_envelope", `Missing required fields: ${missing.join(", ")}`);
  }
  if (request.contract_version !== 1) {
    return makeError("invalid_request_envelope", "contract_version must be 1.");
  }
  if (request.agent !== "codex") {
    return makeError("invalid_request_envelope", 'agent must be "codex".');
  }

  try {
    const rootStat = await stat(request.target_root);
    if (!rootStat.isDirectory()) return makeError("target_root_missing", "target_root is not a directory.");
  } catch {
    return makeError("target_root_missing", "target_root does not exist.");
  }

  if (!(await pathExists(request.prompt_file))) {
    return makeError("prompt_file_missing", "prompt_file does not exist.");
  }
  return null;
}

// launcher が指定されたとき、spawn の command/args を「launcher -c 'exec "$@"' launcher <codex...>」
// 形式に組み直す。POSIX shell の `-c '...' name args` 規約に従い、`exec "$@"` で shell の word
// splitting / 変数展開を完全に bypass する。これにより promptText に `$` などが含まれても
// argv の 1 要素として codex まで届く。launcher は bash / sh / zsh など POSIX shell を想定し、
// 環境差異 (Windows の .cmd shim 等) は agent が --launcher で渡したシェルが解決する。
export function wrapWithLauncher(launcher, command, extraArgs) {
  if (!launcher) return { command, args: extraArgs };
  const launcherCommand = normalizePath(command);
  return {
    command: launcher,
    args: ["-c", 'exec "$@"', launcher, launcherCommand, ...extraArgs],
  };
}

// Codex CLI を initial/resume のどちらかの mode で実行し、event log を保存する。
async function runCodex({ codexBin, codexBinArgs = [], launcher, mode, request, promptText, effort, outputFile, eventLog, threadId }) {
  // prompt は shell 展開を通さず、argv の 1 要素として渡す。
  const args =
    mode === "initial"
      ? [
          "exec",
          "-C",
          request.target_root,
          "--json",
          "--skip-git-repo-check",
          "-c",
          `model_reasoning_effort=${effort}`,
          "-o",
          outputFile,
          promptText,
        ]
      : [
          "exec",
          "resume",
          "--skip-git-repo-check",
          "-c",
          `model_reasoning_effort=${effort}`,
          "-o",
          outputFile,
          threadId,
          promptText,
        ];

  await mkdir(dirname(eventLog), { recursive: true });

  const target = wrapWithLauncher(launcher, codexBin, [...codexBinArgs, ...args]);

  return await new Promise((resolvePromise) => {
    const eventStream = createWriteStream(eventLog, { flags: "w" });
    // CLI trace を 1 つの診断 artifact に残すため、stderr も stdout と同じ log に保存する。
    const child = spawn(target.command, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.pipe(eventStream, { end: false });
    child.stderr.pipe(eventStream, { end: false });

    child.on("error", (error) => {
      eventStream.end(() => {
        resolvePromise({ code: null, signal: null, error, args });
      });
    });

    child.on("close", (code, signal) => {
      eventStream.end(() => {
        resolvePromise({ code, signal, error: null, args });
      });
    });
  });
}

// agent state の artifacts に adapter 生成 artifact を追記する。
async function appendAgentArtifacts(agentState, artifacts) {
  agentState.artifacts ??= [];
  agentState.artifacts.push(...artifacts);
}

// 失敗時の diagnostic、response envelope、可能なら agent state 更新をまとめて行う。
async function handleFailure({ request, agentState, paths, code, message, commandResult = null, extraDiagnostics = [] }) {
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
    const agentStateFile = agentStateFileFor(request.data_dir, request.review_session_id);
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
export async function runAdapter(request, options = {}) {
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

  let sessionState;
  try {
    sessionState = await readJson(sessionStateFile);
  } catch (error) {
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: error.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message:
        error.code === "ENOENT"
          ? "session state file does not exist."
          : `session state file is not valid JSON: ${error.message}`,
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

  let agentState;
  try {
    agentState =
      (await readJsonIfExists(agentStateFile)) ?? {
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
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: `Codex agent state file is not valid JSON: ${error.message}`,
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

// CLI entrypoint。request file を読み込み runner を実行して response file path を stdout に出す。
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (!args.requestFile) throw new Error("--request is required.");
  if (!args.dataDir) throw new Error("--data-dir is required.");

  const input = await readFile(args.requestFile, "utf8");
  const request = JSON.parse(input);
  const response = await runAdapter(request, {
    codexBin: args.codexBin,
    dataDir: args.dataDir,
    launcher: args.launcher,
  });
  const responseFile = normalizePath(
    artifactPaths(artifactDirFor(args.dataDir, request.review_session_id ?? "unknown"), request.round ?? "unknown")
      .responseFile,
  );
  process.stdout.write(`${responseFile}\n`);
  process.exitCode = response.status === "completed" ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
