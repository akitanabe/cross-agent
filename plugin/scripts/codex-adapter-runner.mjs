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
function parseCommandArgs(argv, {
  commands: commands2,
  commonOptions: commonOptions2 = {}
}) {
  const command = argv[0];
  if (command === "--help" || command === "-h") {
    return { command: null, help: true };
  }
  if (command && !commands2[command]) throw new Error(`Unknown command: ${command}`);
  return parseOptionArgs(
    argv,
    { ...commonOptions2, ...commands2[command]?.options ?? {} },
    {
      startIndex: 1,
      initialArgs: { command }
    }
  );
}

// src/core/codex-adapter/cli.ts
var commonOptions = {
  "--data-dir": { field: "dataDir" }
};
var commands = {
  prepare: {
    options: {
      "--request": { field: "requestFile" },
      "-r": { field: "requestFile" }
    }
  },
  complete: {
    options: {
      "--run": { field: "runFile" }
    }
  }
};
function parseArgs(argv) {
  const parsed = parseCommandArgs(argv, {
    commands,
    commonOptions
  });
  return {
    command: parsed.command ?? null,
    requestFile: parsed.requestFile ?? null,
    dataDir: parsed.dataDir ?? null,
    runFile: parsed.runFile ?? null,
    help: parsed.help
  };
}
function usage() {
  return `Usage:
  node scripts/codex-adapter-runner.mjs prepare --data-dir <CLAUDE_PLUGIN_DATA> --request <request-envelope.json>
  node scripts/codex-adapter-runner.mjs complete --data-dir <CLAUDE_PLUGIN_DATA> --run <round-N-codex-run.json>

prepare validates the request/session state and writes a Codex exec run spec. On success, stdout
contains only the run spec file path. On recoverable failure, prepare writes the failed response
envelope to the derived artifact path and exits with an error without printing that path to stdout.

complete validates Codex CLI artifacts written by codex-agent, updates Codex agent state, and
writes the adapter response envelope. stdout contains only the response envelope file path.`;
}

// src/core/shared/path-utils.ts
function normalizePath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (platform !== "win32") return value;
  const isUnc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
  const uncPath = isUnc ? "//" : "";
  const path = isUnc ? value.slice(2) : value;
  let normalized = uncPath + path.replace(/\\/g, "/");
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(normalized);
  if (msys) normalized = `${msys[1].toUpperCase()}:${normalized.slice(2)}`;
  return normalized;
}

// src/core/codex-adapter/workflow-common.ts
function normalizeEnvelopePath(value) {
  return typeof value === "string" && value.includes("\\") ? normalizePath(value, "win32") : normalizePath(value);
}
function normalizeEnvelopePathList(values) {
  if (!Array.isArray(values)) return values;
  return values.map((value) => normalizeEnvelopePath(value));
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeRequest(request) {
  return {
    ...request,
    target_root: normalizeEnvelopePath(request.target_root),
    prompt_file: normalizeEnvelopePath(request.prompt_file),
    context_file: normalizeEnvelopePath(request.context_file),
    target_files: normalizeEnvelopePathList(request.target_files)
  };
}
function responsePath(paths) {
  return normalizeEnvelopePath(paths.responseFile);
}
function runPath(paths) {
  return normalizeEnvelopePath(paths.runFile);
}

// src/core/codex-adapter/workflow-complete.ts
import { readFile as readFile2 } from "node:fs/promises";

// src/core/codex-adapter/agent-state.ts
import { mkdir as mkdir2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";

// src/core/codex-adapter/state.ts
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// src/core/shared/adapter-envelope.ts
var SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
function isSafePathSegment(value) {
  return typeof value === "string" && value.length > 0 && SAFE_PATH_SEGMENT_RE.test(value) && !value.includes("..");
}
function isSafeRoundNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
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
function agentStateFileFor(dataDir, reviewSessionId, agentId = "codex") {
  return resolve(dataDir, "sessions", reviewSessionId, "agents", `${agentId}.json`);
}
function artifactPaths(artifactDir, round, agentId = "codex") {
  return {
    agent_id: agentId,
    adapter: "codex",
    runFile: resolve(artifactDir, `round-${round}-${agentId}-run.json`),
    outputFile: resolve(artifactDir, `round-${round}-${agentId}-output.md`),
    eventLog: resolve(artifactDir, `round-${round}-${agentId}-events.jsonl`),
    exitFile: resolve(artifactDir, `round-${round}-${agentId}-exit.json`),
    diagnosticFile: resolve(artifactDir, `round-${round}-${agentId}-diagnostic.md`),
    responseFile: resolve(artifactDir, `round-${round}-${agentId}-response.json`)
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
function artifact(path, kind, round, agentId = "codex") {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent_id: agentId,
    adapter: "codex",
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
    contract_version: 2,
    review_session_id: request?.review_session_id ?? null,
    agent_id: request?.agent_id ?? null,
    adapter: "codex",
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
    "agent_id",
    "adapter",
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
  if (request.contract_version !== 2) {
    return makeError("invalid_request_envelope", "contract_version must be 2.");
  }
  if (request.adapter !== "codex") {
    return makeError("invalid_request_envelope", 'adapter must be "codex".');
  }
  if (!isSafePathSegment(request.review_session_id)) {
    return makeError("invalid_request_envelope", `invalid review_session_id: ${request.review_session_id}`);
  }
  if (!isSafePathSegment(request.agent_id)) {
    return makeError("invalid_request_envelope", `invalid agent_id: ${request.agent_id}`);
  }
  if (!isSafeRoundNumber(request.round)) {
    return makeError("invalid_request_envelope", `invalid round: ${request.round}`);
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

// src/core/codex-adapter/agent-state.ts
async function appendAgentArtifacts(agentState, artifacts) {
  agentState.artifacts ??= [];
  agentState.artifacts.push(...artifacts);
}
async function saveAgentState(dataDir, reviewSessionId, agentState) {
  const agentStateFile = agentStateFileFor(dataDir, reviewSessionId, agentState.agent_id);
  await mkdir2(dirname2(agentStateFile), { recursive: true });
  await writeJsonAtomic(agentStateFile, agentState);
}
async function readSessionState(dataDir, reviewSessionId) {
  const state = await readJson(sessionStateFileFor(dataDir, reviewSessionId));
  if (state.schema_version !== 2) {
    throw new Error(
      `unsupported agent-review session schema_version ${state.schema_version ?? "missing"}; expected 2.`
    );
  }
  return state;
}
async function readOrCreateAgentState(dataDir, request) {
  const agentStateFile = agentStateFileFor(dataDir, request.review_session_id, request.agent_id);
  return await readJsonIfExists(agentStateFile) ?? {
    schema_version: 1,
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "codex",
    status: "pending",
    thread_id: null,
    target_root: null,
    last_run_file: null,
    last_output_file: null,
    last_event_log: null,
    last_exit_file: null,
    last_error: null,
    artifacts: [],
    errors: []
  };
}
async function markAgentPrepared(dataDir, request, paths, agentState) {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "codex",
    status: "prepared",
    target_root: agentState.target_root ?? request.target_root,
    last_run_file: paths.runFile,
    last_event_log: paths.eventLog,
    last_exit_file: paths.exitFile,
    last_error: null
  });
  await saveAgentState(dataDir, request.review_session_id, agentState);
}
async function markAgentCompleted({
  dataDir,
  runSpec,
  paths,
  agentState,
  threadId,
  artifacts
}) {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: runSpec.review_session_id,
    agent_id: runSpec.agent_id,
    adapter: "codex",
    status: "active",
    thread_id: threadId,
    target_root: runSpec.target_root,
    last_run_file: paths.runFile,
    last_output_file: runSpec.output_file,
    last_event_log: runSpec.event_log,
    last_exit_file: runSpec.exit_file,
    last_error: null
  });
  await appendAgentArtifacts(agentState, artifacts);
  await saveAgentState(dataDir, runSpec.review_session_id, agentState);
}

// src/core/codex-adapter/workflow-failure.ts
var CodexPrepareFailedError = class extends Error {
  path;
  response;
  constructor(path, response) {
    super(response.error?.message ?? "Codex prepare failed.");
    this.name = "CodexPrepareFailedError";
    this.path = path;
    this.response = response;
  }
};
async function writeFailureDiagnostic({
  request,
  paths,
  code,
  message,
  exitCode = null,
  extraDiagnostics = []
}) {
  await writeDiagnostic(paths.diagnosticFile, [
    `# Codex adapter diagnostic`,
    ``,
    `- status: failed`,
    `- code: ${code}`,
    `- message: ${message}`,
    `- round: ${request.round}`,
    `- target_root: ${request.target_root}`,
    exitCode !== null ? `- exit_code: ${exitCode}` : null,
    ...extraDiagnostics
  ]);
}
async function updateFailedAgentState({ request, agentState, paths, code, message }) {
  if (!agentState) return;
  const error = makeError(code, message, paths.diagnosticFile);
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "codex",
    status: "failed",
    thread_id: agentState.thread_id ?? null,
    target_root: agentState.target_root ?? request.target_root,
    last_run_file: agentState.last_run_file ?? paths.runFile,
    last_output_file: agentState.last_output_file ?? null,
    last_event_log: paths.eventLog,
    last_exit_file: paths.exitFile,
    last_error: error
  });
  await appendAgentArtifacts(agentState, [
    artifact(paths.diagnosticFile, "diagnostic", request.round, request.agent_id)
  ]);
  agentState.errors ??= [];
  agentState.errors.push({
    ...error,
    agent_id: request.agent_id,
    adapter: "codex",
    round: request.round,
    created_at: nowIso()
  });
  await saveAgentState(request.data_dir ?? ".", request.review_session_id, agentState);
}
async function handleFailure(input) {
  const diagnosticArtifact = artifact(
    input.paths.diagnosticFile,
    "diagnostic",
    input.request.round,
    input.request.agent_id
  );
  const error = makeError(input.code, input.message, input.paths.diagnosticFile);
  const response = makeResponse(input.request, "failed", null, [diagnosticArtifact], error);
  await writeFailureDiagnostic(input);
  await updateFailedAgentState(input);
  await writeJsonAtomic(input.paths.responseFile, response);
  return response;
}
async function failPrepare(input) {
  const response = await handleFailure(input);
  throw new CodexPrepareFailedError(responsePath(input.paths), response);
}
async function failComplete(input) {
  const response = await handleFailure(input);
  return { path: responsePath(input.paths), response };
}

// src/core/codex-adapter/workflow-complete-helpers.ts
async function loadAgentStateForComplete(dataDir, runSpec, request, paths) {
  let agentState;
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
          message: "session state file review_session_id does not match run spec."
        })
      };
    }
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error;
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths,
        code: caught.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
        message: caught.code === "ENOENT" ? "session state file does not exist." : `state file is not valid JSON: ${caught.message}`
      })
    };
  }
  if (agentState.review_session_id !== runSpec.review_session_id || agentState.agent_id !== runSpec.agent_id) {
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths,
        code: "state_file_invalid",
        message: "Codex agent state file review_session_id or agent_id does not match run spec."
      })
    };
  }
  return { ok: true, agentState };
}
async function resolveCompletedThreadId(runSpec, request, paths, agentState, exitCode, eventLogText) {
  if (runSpec.mode === "resume") {
    return { ok: true, threadId: runSpec.thread_id };
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
        runSpec.previous_target_root ? `- previous_target_root: ${runSpec.previous_target_root}` : null
      ]
    })
  };
}

// src/core/codex-adapter/workflow-completion-artifacts.ts
function completedArtifacts(runSpec, paths) {
  return [
    artifact(paths.runFile, "run_spec", runSpec.round, runSpec.agent_id),
    artifact(runSpec.output_file, "agent_output", runSpec.round, runSpec.agent_id),
    artifact(runSpec.event_log, "event_log", runSpec.round, runSpec.agent_id),
    artifact(runSpec.exit_file, "exit_status", runSpec.round, runSpec.agent_id)
  ];
}
async function appendCompletionDiagnostic(runSpec, paths, threadId, artifacts) {
  if (!runSpec.warning && runSpec.decision_reason !== "target_root_changed") return;
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
    `- target_root: ${runSpec.target_root}`
  ]);
  artifacts.push(artifact(paths.diagnosticFile, "diagnostic", runSpec.round, runSpec.agent_id));
}

// src/core/codex-adapter/workflow-run-spec.ts
import { dirname as dirname3 } from "node:path";
function makeRequestFromRunSpec(runSpec, dataDir) {
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
    data_dir: dataDir
  };
}
function roundFromRunFile(runFile) {
  const match = /round-(\d+)-([A-Za-z0-9._-]+)-run\.json$/.exec(runFile.replaceAll("\\", "/"));
  return match ? Number(match[1]) : 0;
}
function makeFallbackRequestForRunSpec(value, runFile, dataDir) {
  const object = isObject(value) ? value : {};
  const reviewSessionId = typeof object.review_session_id === "string" && object.review_session_id ? object.review_session_id : "unknown";
  const round = Number.isSafeInteger(object.round) ? object.round : roundFromRunFile(runFile);
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
    data_dir: dataDir
  };
}
function fallbackPathsForRunSpec(value, runFile, dataDir) {
  const object = isObject(value) ? value : {};
  const round = Number.isSafeInteger(object.round) ? object.round : roundFromRunFile(runFile);
  if (typeof object.review_session_id === "string" && object.review_session_id) {
    return artifactPaths(artifactDirFor(dataDir, object.review_session_id), round, agentIdFromRunFile(runFile));
  }
  return artifactPaths(dirname3(runFile), round, agentIdFromRunFile(runFile));
}
function validateRunSpec(value) {
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
    "model_reasoning_effort"
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
  if (!["medium", "high", "xhigh"].includes(value.model_reasoning_effort)) {
    return { runSpec: null, message: "model_reasoning_effort is not allowed." };
  }
  if (value.skip_git_repo_check !== true) {
    return { runSpec: null, message: "skip_git_repo_check must be true." };
  }
  if (value.ask_for_approval !== "never") {
    return { runSpec: null, message: 'ask_for_approval must be "never".' };
  }
  return { runSpec: value, message: null };
}
function makeCodexRunSpec(request, paths, agentState) {
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
    target_root: normalizePath(request.target_root),
    thread_id: decision.startNew ? null : agentState.thread_id,
    prompt_file: normalizePath(request.prompt_file),
    output_file: normalizePath(paths.outputFile),
    event_log: normalizePath(paths.eventLog),
    exit_file: normalizePath(paths.exitFile),
    model_reasoning_effort: effort,
    skip_git_repo_check: true,
    ask_for_approval: "never",
    decision_reason: decision.reason,
    previous_thread_id: agentState.thread_id ?? null,
    previous_target_root: agentState.target_root ?? null,
    warning
  };
}
async function readCodexExit(exitFile) {
  const exitResult = await readJson(exitFile);
  if (!isObject(exitResult) || !Number.isInteger(exitResult.code)) {
    throw new Error("codex exit file must contain numeric code.");
  }
  return { code: exitResult.code };
}
async function loadRunSpecForComplete(runFile, dataDir) {
  let rawRunSpec;
  try {
    rawRunSpec = await readJson(runFile);
  } catch (error) {
    const caught = error;
    const request = makeFallbackRequestForRunSpec(null, runFile, dataDir);
    const paths2 = fallbackPathsForRunSpec(null, runFile, dataDir);
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths: paths2,
        code: "codex_run_spec_invalid",
        message: `codex run spec is missing or invalid: ${caught.message}`
      })
    };
  }
  const { runSpec, message } = validateRunSpec(rawRunSpec);
  if (!runSpec) {
    const request = makeFallbackRequestForRunSpec(rawRunSpec, runFile, dataDir);
    const paths2 = fallbackPathsForRunSpec(rawRunSpec, runFile, dataDir);
    return {
      ok: false,
      result: await failComplete({
        request,
        agentState: null,
        paths: paths2,
        code: "codex_run_spec_invalid",
        message: message ?? "invalid run spec."
      })
    };
  }
  const artifactDir = artifactDirFor(dataDir, runSpec.review_session_id);
  const paths = artifactPaths(artifactDir, runSpec.round, runSpec.agent_id);
  return { ok: true, value: { runSpec, request: makeRequestFromRunSpec(runSpec, dataDir), paths } };
}
function mismatchedRunSpecPath(runSpec, paths) {
  const expectedPaths = {
    output_file: paths.outputFile,
    event_log: paths.eventLog,
    exit_file: paths.exitFile
  };
  for (const [field, expectedPath] of Object.entries(expectedPaths)) {
    if (normalizePath(runSpec[field]) !== normalizePath(expectedPath)) {
      return field;
    }
  }
  return null;
}
function agentIdFromRunFile(runFile) {
  const match = /round-\d+-([A-Za-z0-9._-]+)-run\.json$/.exec(runFile.replaceAll("\\", "/"));
  return match ? match[1] : "codex";
}

// src/core/codex-adapter/workflow-complete.ts
async function completeCodexRun(runFile, options = {}) {
  const dataDir = options.dataDir ? normalizePath(options.dataDir) : null;
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
      message: `${mismatchedPath} does not match derived artifact path.`
    });
  }
  const loadedAgentState = await loadAgentStateForComplete(dataDir, runSpec, request, paths);
  if (!loadedAgentState.ok) return loadedAgentState.result;
  const { agentState } = loadedAgentState;
  let exitResult;
  try {
    exitResult = await readCodexExit(runSpec.exit_file);
  } catch (error) {
    const caught = error;
    return failComplete({
      request,
      agentState,
      paths,
      code: "codex_exit_missing",
      message: `codex exit file is missing or invalid: ${caught.message}`
    });
  }
  const eventLogText = await pathExists(runSpec.event_log) ? await readFile2(runSpec.event_log, "utf8") : "";
  if (exitResult.code !== 0) {
    const mode = runSpec.mode;
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
        runSpec.warning ? `- warning: ${runSpec.warning}` : null
      ]
    });
  }
  const completedThread = await resolveCompletedThreadId(
    runSpec,
    request,
    paths,
    agentState,
    exitResult.code,
    eventLogText
  );
  if (!completedThread.ok) return completedThread.result;
  const { threadId } = completedThread;
  if (!await pathExists(runSpec.output_file)) {
    return failComplete({
      request,
      agentState,
      paths,
      code: "codex_output_missing",
      message: "codex output file was not created.",
      exitCode: exitResult.code
    });
  }
  const artifacts = completedArtifacts(runSpec, paths);
  await appendCompletionDiagnostic(runSpec, paths, threadId, artifacts);
  await markAgentCompleted({ dataDir, runSpec, paths, agentState, threadId, artifacts });
  const response = makeResponse(request, "completed", runSpec.output_file, artifacts, null);
  await writeJsonAtomic(paths.responseFile, response);
  return { path: responsePath(paths), response };
}

// src/core/codex-adapter/workflow-prepare.ts
import { mkdir as mkdir3 } from "node:fs/promises";
async function prepareCodexRun(request, options = {}) {
  const dataDir = options.dataDir ? normalizePath(options.dataDir) : null;
  request = normalizeRequest(request);
  if (!dataDir) {
    throw new Error(
      makeError(
        "invalid_request_envelope",
        '--data-dir is required. In plugin context, pass `--data-dir "${CLAUDE_PLUGIN_DATA}"` (Claude Code substitutes this in skill content).'
      ).message
    );
  }
  const requestWithDataDir = { ...request, data_dir: dataDir };
  const artifactDir = artifactDirFor(dataDir, request.review_session_id ?? "unknown");
  const pathRound = isSafeRoundNumber(request.round) ? request.round : "unknown";
  const paths = artifactPaths(artifactDir, pathRound, request.agent_id ?? "unknown");
  await mkdir3(artifactDir, { recursive: true });
  const validationError = await validateRequest(request);
  if (validationError) {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: validationError.code,
      message: validationError.message
    });
  }
  let sessionState;
  try {
    sessionState = await readSessionState(dataDir, request.review_session_id);
  } catch (error) {
    const nodeError = error;
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: nodeError.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message: nodeError.code === "ENOENT" ? "session state file does not exist." : `session state file is not valid JSON: ${nodeError.message}`
    });
  }
  if (sessionState.review_session_id !== request.review_session_id) {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "session state file review_session_id does not match request."
    });
  }
  let agentState;
  try {
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error;
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: `Codex agent state file is not valid JSON: ${caught.message}`
    });
  }
  if (agentState.review_session_id !== request.review_session_id || agentState.agent_id !== request.agent_id) {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Codex agent state file review_session_id or agent_id does not match request."
    });
  }
  const runSpec = makeCodexRunSpec(request, paths, agentState);
  await writeJsonAtomic(paths.runFile, runSpec);
  await markAgentPrepared(dataDir, request, paths, agentState);
  return { kind: "run", path: runPath(paths), status: "prepared" };
}

// src/runners/codex-adapter-runner.ts
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}
`);
    return;
  }
  if (!args.command) throw new Error("command is required. Use prepare or complete.");
  if (!args.dataDir) throw new Error("--data-dir is required.");
  if (args.command === "prepare") {
    if (!args.requestFile) throw new Error("--request is required.");
    const input = await readFile3(args.requestFile, "utf8");
    const request = JSON.parse(input);
    try {
      const result = await prepareCodexRun(request, { dataDir: args.dataDir });
      process.stdout.write(`${result.path}
`);
    } catch (error) {
      if (!(error instanceof CodexPrepareFailedError)) throw error;
      process.stderr.write(`${error.name}: ${error.message}
`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.command === "complete") {
    if (!args.runFile) throw new Error("--run is required.");
    const result = await completeCodexRun(args.runFile, { dataDir: args.dataDir });
    process.stdout.write(`${result.path}
`);
    process.exitCode = result.response.status === "completed" ? 0 : 1;
    return;
  }
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
