#!/usr/bin/env node

// src/runners/codex-adapter-runner.ts
import { readFile as readFile3 } from "node:fs/promises";
import { resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/shared/cli-args.ts
function parseOptionValue(option, value, optionName) {
  return option.parse ? option.parse(value, optionName) : value;
}
function parseOptionArgs(argv, optionDefinitions, { startIndex = 0, initialArgs = {} } = {}) {
  const args = { ...initialArgs };
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    const option = optionDefinitions[arg];
    if (!option) {
      if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    if (option.multiple) {
      const values = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        values.push(argv[++index]);
      }
      if (!values.length) throw new Error(`${arg} requires at least one value.`);
      args[option.field] ??= [];
      args[option.field].push(...values.map((value2) => parseOptionValue(option, value2, arg)));
      continue;
    }
    const value = argv[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    args[option.field] = parseOptionValue(option, value, arg);
  }
  return args;
}

// src/core/codex-adapter/cli.ts
var optionArgs = {
  "--request": { field: "requestFile" },
  "-r": { field: "requestFile" },
  "--codex-bin": { field: "codexBin" },
  "--data-dir": { field: "dataDir" },
  "--launcher": {
    field: "launcher",
    // codex 起動を POSIX shell 経由で wrap する。空文字なら未指定扱い (直接 spawn) にする。
    parse: (value) => value === "" ? null : value
  }
};
function parseArgs(argv) {
  return parseOptionArgs(argv, optionArgs, {
    initialArgs: {
      requestFile: null,
      codexBin: "codex",
      dataDir: null,
      launcher: null
    }
  });
}
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

// src/core/codex-adapter/state.ts
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// src/core/shared/path-utils.ts
function normalizePath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (platform !== "win32") return value;
  let normalized = value.replace(/\\/g, "/");
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(normalized);
  if (msys) normalized = `${msys[1].toUpperCase()}:${normalized.slice(2)}`;
  return normalized;
}
function normalizePathList(values, platform = process.platform) {
  if (!Array.isArray(values)) return values;
  return values.map((value) => normalizePath(value, platform));
}

// src/core/codex-adapter/state.ts
var OWNER = "codex-adapter";
function effortForReviewDepth(reviewDepth) {
  if (reviewDepth === "low") return { effort: "medium", warning: null };
  if (reviewDepth === "medium") return { effort: "high", warning: null };
  if (reviewDepth === "high") return { effort: "xhigh", warning: null };
  return {
    effort: "high",
    warning: `Unknown review_depth "${reviewDepth ?? ""}". Falling back to high.`
  };
}
function artifactDirFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "artifacts", reviewSessionId);
}
function sessionStateFileFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "sessions", `${reviewSessionId}.json`);
}
function agentStateFileFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "sessions", reviewSessionId, "agents", "codex.json");
}
function artifactPaths(artifactDir, round) {
  return {
    outputFile: resolve(artifactDir, `round-${round}-codex-output.md`),
    eventLog: resolve(artifactDir, `round-${round}-codex-events.jsonl`),
    diagnosticFile: resolve(artifactDir, `round-${round}-codex-diagnostic.md`),
    responseFile: resolve(artifactDir, `round-${round}-codex-response.json`)
  };
}
function extractThreadIdFromJsonl(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
        return event.thread_id;
      }
    } catch {
    }
  }
  return null;
}
function shouldStartNewSession(agentState, targetRoot) {
  if (!agentState?.thread_id) {
    return { startNew: true, reason: "missing_thread_id" };
  }
  if (agentState.target_root !== targetRoot) {
    return { startNew: true, reason: "target_root_changed" };
  }
  return { startNew: false, reason: "resume" };
}
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
async function readJsonIfExists(filePath) {
  return await pathExists(filePath) ? await readJson(filePath) : null;
}
async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename(tmp, filePath);
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function artifact(path, kind, round, agent = "codex") {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent,
    created_at: nowIso(),
    temporary: false
  };
}
function makeError(code, message, detailsFile = null) {
  return {
    code,
    message,
    recoverable: true,
    details_file: detailsFile
  };
}
function makeResponse(request, status, outputFile, artifacts, error) {
  const normalizedArtifacts = (artifacts ?? []).map(
    (entry) => entry?.path ? { ...entry, path: normalizePath(entry.path) } : entry
  );
  const normalizedError = error && error.details_file ? { ...error, details_file: normalizePath(error.details_file) } : error;
  return {
    contract_version: 1,
    review_session_id: request?.review_session_id ?? null,
    agent: "codex",
    round: request?.round ?? null,
    status,
    output_file: outputFile ? normalizePath(outputFile) : outputFile,
    artifacts: normalizedArtifacts,
    error: normalizedError
  };
}
async function writeDiagnostic(filePath, lines) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.filter(Boolean).join("\n")}
`, "utf8");
}
async function validateRequest(request) {
  const required = [
    "contract_version",
    "review_session_id",
    "agent",
    "round",
    "round_kind",
    "target_root",
    "prompt_file",
    "options"
  ];
  const missing = required.filter((key) => request[key] === void 0 || request[key] === null || request[key] === "");
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
  if (!await pathExists(request.prompt_file)) {
    return makeError("prompt_file_missing", "prompt_file does not exist.");
  }
  return null;
}

// src/core/codex-adapter/workflow.ts
import { mkdir as mkdir3, readFile as readFile2 } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";

// src/core/codex-adapter/process.ts
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir as mkdir2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
function wrapWithLauncher(launcher, command, extraArgs) {
  if (!launcher) return { command, args: extraArgs };
  const launcherCommand = normalizePath(command);
  return {
    command: launcher,
    args: ["-c", 'exec "$@"', launcher, launcherCommand, ...extraArgs]
  };
}
async function runCodex({
  codexBin,
  codexBinArgs = [],
  launcher,
  mode,
  request,
  promptText,
  effort,
  outputFile,
  eventLog,
  threadId
}) {
  const args = mode === "initial" ? [
    "exec",
    "-C",
    request.target_root,
    "--json",
    "--skip-git-repo-check",
    "-c",
    `model_reasoning_effort=${effort}`,
    "-o",
    outputFile,
    promptText
  ] : [
    "exec",
    "resume",
    "--skip-git-repo-check",
    "-c",
    `model_reasoning_effort=${effort}`,
    "-o",
    outputFile,
    threadId ?? "",
    promptText
  ];
  await mkdir2(dirname2(eventLog), { recursive: true });
  const target = wrapWithLauncher(launcher, codexBin, [...codexBinArgs, ...args]);
  return await new Promise((resolvePromise) => {
    const eventStream = createWriteStream(eventLog, { flags: "w" });
    const child = spawn(target.command, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
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

// src/core/codex-adapter/workflow.ts
async function appendAgentArtifacts(agentState, artifacts) {
  agentState.artifacts ??= [];
  agentState.artifacts.push(...artifacts);
}
async function handleFailure({
  request,
  agentState,
  paths,
  code,
  message,
  commandResult = null,
  extraDiagnostics = []
}) {
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
    ...extraDiagnostics
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
      last_error: error
    });
    await appendAgentArtifacts(agentState, [diagnosticArtifact]);
    agentState.errors ??= [];
    agentState.errors.push({ ...error, agent: "codex", round: request.round, created_at: nowIso() });
    await mkdir3(dirname3(agentStateFile), { recursive: true });
    await writeJsonAtomic(agentStateFile, agentState);
  }
  await writeJsonAtomic(paths.responseFile, response);
  return response;
}
async function runAdapter(request, options = {}) {
  const codexBin = options.codexBin ?? "codex";
  const codexBinArgs = options.codexBinArgs ?? [];
  const launcher = options.launcher ?? null;
  const dataDir = options.dataDir ? normalizePath(options.dataDir) : null;
  request = {
    ...request,
    target_root: normalizePath(request.target_root),
    prompt_file: normalizePath(request.prompt_file),
    context_file: normalizePath(request.context_file),
    target_files: normalizePathList(request.target_files)
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
        '--data-dir is required. In plugin context, pass `--data-dir "${CLAUDE_PLUGIN_DATA}"` (Claude Code substitutes this in skill content).'
      )
    );
  }
  await mkdir3(artifactDir, { recursive: true });
  const validationError = await validateRequest(request);
  if (validationError) {
    const response2 = await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: validationError.code,
      message: validationError.message
    });
    return response2;
  }
  let sessionState;
  try {
    sessionState = await readJson(sessionStateFile);
  } catch (error) {
    const nodeError = error;
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: nodeError.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message: nodeError.code === "ENOENT" ? "session state file does not exist." : `session state file is not valid JSON: ${nodeError.message}`
    });
  }
  if (sessionState.review_session_id !== request.review_session_id) {
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "session state file review_session_id does not match request."
    });
  }
  let agentState;
  try {
    agentState = await readJsonIfExists(agentStateFile) ?? {
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
      errors: []
    };
  } catch (error) {
    const caught = error;
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: `Codex agent state file is not valid JSON: ${caught.message}`
    });
  }
  if (agentState.review_session_id !== request.review_session_id || agentState.agent !== "codex") {
    return await handleFailure({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Codex agent state file review_session_id or agent does not match request."
    });
  }
  const promptText = await readFile2(request.prompt_file, "utf8");
  const { effort, warning } = effortForReviewDepth(request.options?.review_depth);
  const existingAgentState = agentState;
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
    threadId: existingAgentState.thread_id
  });
  const eventLogText = await pathExists(paths.eventLog) ? await readFile2(paths.eventLog, "utf8") : "";
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
        warning ? `- warning: ${warning}` : null
      ]
    });
  }
  let threadId = existingAgentState.thread_id;
  if (decision.startNew) {
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
          oldTargetRoot ? `- previous_target_root: ${oldTargetRoot}` : null
        ]
      });
    }
  }
  if (!await pathExists(paths.outputFile)) {
    return await handleFailure({
      request: requestWithDataDir,
      agentState,
      paths,
      code: "codex_output_missing",
      message: "codex output file was not created.",
      commandResult
    });
  }
  const artifacts = [
    artifact(paths.outputFile, "agent_output", request.round),
    artifact(paths.eventLog, "event_log", request.round)
  ];
  if (warning || decision.reason === "target_root_changed") {
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
      `- target_root: ${request.target_root}`
    ]);
    artifacts.push(artifact(paths.diagnosticFile, "diagnostic", request.round));
  }
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent: "codex",
    status: "active",
    thread_id: threadId,
    target_root: request.target_root,
    last_output_file: paths.outputFile,
    last_event_log: paths.eventLog,
    last_error: null
  });
  await appendAgentArtifacts(agentState, artifacts);
  await mkdir3(dirname3(agentStateFile), { recursive: true });
  await writeJsonAtomic(agentStateFile, agentState);
  const response = makeResponse(requestWithDataDir, "completed", paths.outputFile, artifacts, null);
  await writeJsonAtomic(paths.responseFile, response);
  return response;
}

// src/runners/codex-adapter-runner.ts
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}
`);
    return;
  }
  if (!args.requestFile) throw new Error("--request is required.");
  if (!args.dataDir) throw new Error("--data-dir is required.");
  const input = await readFile3(args.requestFile, "utf8");
  const request = JSON.parse(input);
  const response = await runAdapter(request, {
    codexBin: args.codexBin,
    dataDir: args.dataDir,
    launcher: args.launcher
  });
  const responseFile = normalizePath(
    artifactPaths(artifactDirFor(args.dataDir, request.review_session_id ?? "unknown"), request.round ?? "unknown").responseFile
  );
  process.stdout.write(`${responseFile}
`);
  process.exitCode = response.status === "completed" ? 0 : 1;
}
var invokedPath = process.argv[1] ? resolve2(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const caught = error;
    process.stderr.write(`${caught.stack ?? caught.message}
`);
    process.exitCode = 1;
  });
}
export {
  agentStateFileFor,
  artifactDirFor,
  artifactPaths,
  effortForReviewDepth,
  extractThreadIdFromJsonl,
  parseArgs,
  runAdapter,
  sessionStateFileFor,
  shouldStartNewSession,
  usage,
  wrapWithLauncher
};
