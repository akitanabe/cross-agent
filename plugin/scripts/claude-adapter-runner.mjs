#!/usr/bin/env node

// src/runners/claude-adapter-runner.ts
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

// src/core/claude-adapter/cli.ts
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
      "--request": { field: "requestFile" },
      "-r": { field: "requestFile" },
      "--output-file": { field: "outputFile" }
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
    outputFile: parsed.outputFile ?? null,
    help: parsed.help
  };
}
function usage() {
  return `Usage:
  node scripts/claude-adapter-runner.mjs prepare --data-dir <CLAUDE_PLUGIN_DATA> --request <request-envelope.json>
  node scripts/claude-adapter-runner.mjs complete --data-dir <CLAUDE_PLUGIN_DATA> --request <request-envelope.json> --output-file <round-N-claude-output.md>

prepare validates the request/session state and writes the Claude input/context artifacts. On
success, stdout contains only the Claude input file path. On recoverable failure, prepare writes
the failed response envelope to the derived artifact path and exits with an error without printing
that path to stdout.

complete validates the Claude output artifact, updates Claude agent state, and writes the adapter
response envelope. stdout contains only the response envelope file path.`;
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

// src/core/claude-adapter/workflow-common.ts
function normalizeEnvelopePath(value) {
  return typeof value === "string" && value.includes("\\") ? normalizePath(value, "win32") : normalizePath(value);
}
function normalizeEnvelopePathList(values) {
  if (!Array.isArray(values)) return values;
  return values.map((value) => normalizeEnvelopePath(value));
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
function inputPath(paths) {
  return normalizeEnvelopePath(paths.inputFile);
}
function outputPath(paths) {
  return normalizeEnvelopePath(paths.outputFile);
}
function toDisplayPath(filePath) {
  return normalizeEnvelopePath(filePath) ?? "";
}

// src/core/claude-adapter/workflow-complete.ts
import { readFile as readFile2 } from "node:fs/promises";

// src/core/claude-adapter/agent-state.ts
import { mkdir as mkdir2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";

// src/core/claude-adapter/state.ts
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

// src/core/claude-adapter/state.ts
var OWNER = "claude-adapter";
function artifactDirFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "artifacts", reviewSessionId);
}
function sessionStateFileFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "sessions", `${reviewSessionId}.json`);
}
function agentStateDirFor(dataDir, reviewSessionId) {
  return resolve(dataDir, "sessions", reviewSessionId, "agents");
}
function agentStateFileFor(dataDir, reviewSessionId, agentId = "claude") {
  return resolve(agentStateDirFor(dataDir, reviewSessionId), `${agentId}.json`);
}
function agentContextFileFor(dataDir, reviewSessionId, agentId = "claude") {
  return resolve(agentStateDirFor(dataDir, reviewSessionId), `${agentId}-context.md`);
}
function artifactPaths(artifactDir, round, agentId = "claude") {
  return {
    agent_id: agentId,
    adapter: "claude",
    inputFile: resolve(artifactDir, `round-${round}-${agentId}-input.md`),
    outputFile: resolve(artifactDir, `round-${round}-${agentId}-output.md`),
    diagnosticFile: resolve(artifactDir, `round-${round}-${agentId}-diagnostic.md`),
    responseFile: resolve(artifactDir, `round-${round}-${agentId}-response.json`)
  };
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
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename(tmp, filePath);
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function artifact(path, kind, round, agentId = "claude") {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent_id: agentId,
    adapter: "claude",
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
    adapter: "claude",
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
  if (request.contract_version !== 2) return makeError("invalid_request_envelope", "contract_version must be 2.");
  if (request.adapter !== "claude") return makeError("invalid_request_envelope", 'adapter must be "claude".');
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

// src/core/claude-adapter/agent-state.ts
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
    adapter: "claude",
    status: "pending",
    target_root: null,
    context_file: agentContextFileFor(dataDir, request.review_session_id, request.agent_id),
    last_input_file: null,
    last_output_file: null,
    last_error: null,
    artifacts: [],
    errors: []
  };
}
async function markAgentPrepared(dataDir, request, paths, contextFile, agentState) {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "claude",
    status: "prepared",
    target_root: request.target_root,
    context_file: contextFile,
    last_input_file: paths.inputFile,
    last_error: null
  });
  await saveAgentState(dataDir, request.review_session_id, agentState);
}
async function markAgentCompleted({
  dataDir,
  request,
  paths,
  contextFile,
  agentState,
  artifacts
}) {
  agentState.updated_at = nowIso();
  Object.assign(agentState, {
    schema_version: agentState.schema_version ?? 1,
    review_session_id: request.review_session_id,
    agent_id: request.agent_id,
    adapter: "claude",
    status: "active",
    target_root: request.target_root,
    context_file: contextFile,
    last_input_file: paths.inputFile,
    last_output_file: paths.outputFile,
    last_error: null
  });
  await appendAgentArtifacts(agentState, artifacts);
  await saveAgentState(dataDir, request.review_session_id, agentState);
}

// src/core/claude-adapter/context.ts
import { mkdir as mkdir3, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";
function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}
function buildClaudeContext({
  request,
  sessionState,
  currentPaths
}) {
  const targetFiles = uniqueStrings([...request.target_files ?? [], ...sessionState.context?.target_files ?? []]);
  const priorRounds = (sessionState.rounds ?? []).filter((round) => typeof round.round === "number" && round.round < request.round).flatMap(
    (round) => (round.agents ?? []).filter((agent) => agent.adapter === "claude" && agent.agent_id === request.agent_id).map((agent) => ({ round: round.round, kind: round.kind, agent }))
  ).sort((left, right) => (left.round ?? 0) - (right.round ?? 0));
  const lines = [
    `# Claude adapter context`,
    ``,
    `## Session`,
    ``,
    `- review_session_id: ${request.review_session_id}`,
    `- target_root: ${toDisplayPath(request.target_root)}`,
    ``,
    `## References`,
    ``,
    `### Target files`,
    ``,
    ...targetFiles.length ? targetFiles.map((file) => `- ${toDisplayPath(file)}`) : [`- none`],
    ``,
    `## Required Reading`,
    ``,
    "`claude-agent` must read all files listed here before answering. If any file cannot be read, it must not infer",
    `the contents.`,
    ``,
    `### Prior rounds`,
    ``
  ];
  if (priorRounds.length) {
    for (const round of priorRounds) {
      if (round.agent.prompt_file) lines.push(`- prompt_file: ${toDisplayPath(round.agent.prompt_file)}`);
      if (round.agent.agent_result?.output_file)
        lines.push(`- output_file: ${toDisplayPath(round.agent.agent_result.output_file)}`);
    }
  } else {
    lines.push(`- none`);
  }
  lines.push(``, `## Rounds`, ``);
  for (const round of priorRounds) {
    lines.push(`### Round ${round.round}: ${round.kind ?? "unknown"}`, ``);
    if (round.agent.prompt_file) lines.push(`- prompt_file: ${toDisplayPath(round.agent.prompt_file)}`);
    if (round.agent.agent_result?.output_file)
      lines.push(`- output_file: ${toDisplayPath(round.agent.agent_result.output_file)}`);
    lines.push(``);
  }
  lines.push(
    `### Round ${request.round}: ${request.round_kind}`,
    ``,
    `- prompt_file: ${toDisplayPath(request.prompt_file)}`,
    `- output_file: ${toDisplayPath(currentPaths.outputFile)}`,
    `- response_file: ${toDisplayPath(currentPaths.responseFile)}`,
    `- diagnostic_file: ${toDisplayPath(currentPaths.diagnosticFile)}`,
    ``
  );
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}
`;
}
function buildClaudeInput({
  request,
  contextFile,
  outputFile
}) {
  return `${[
    `# Claude adapter input`,
    ``,
    `## Current Round`,
    ``,
    `- prompt_file: ${toDisplayPath(request.prompt_file)}`,
    ``,
    `## Session Context`,
    ``,
    `- claude_context_file: ${toDisplayPath(contextFile)}`,
    ``,
    `Read this context file before answering. Then read all files listed in its Required Reading section.`,
    `If any required file cannot be read, do not infer its contents. Report failure through the adapter flow instead.`,
    ``,
    `## Request`,
    ``,
    `- review_session_id: ${request.review_session_id}`,
    `- round: ${request.round}`,
    `- round_kind: ${request.round_kind}`,
    `- target_root: ${toDisplayPath(request.target_root)}`,
    `- focus_question: ${request.focus_question ?? ""}`,
    ``,
    `## Output`,
    ``,
    `Write the final review body to:`,
    ``,
    `${toDisplayPath(outputFile)}`,
    ``
  ].join("\n")}`;
}
async function writeTextFile(filePath, text) {
  await mkdir3(dirname3(filePath), { recursive: true });
  await writeFile2(filePath, text, "utf8");
}

// src/core/claude-adapter/workflow-failure.ts
var ClaudePrepareFailedError = class extends Error {
  path;
  response;
  constructor(path, response) {
    super(response.error?.message ?? "Claude prepare failed.");
    this.name = "ClaudePrepareFailedError";
    this.path = path;
    this.response = response;
  }
};
async function writeFailureDiagnostic({
  request,
  paths,
  code,
  message,
  extraDiagnostics = []
}) {
  await writeDiagnostic(paths.diagnosticFile, [
    `# Claude adapter diagnostic`,
    ``,
    `- status: failed`,
    `- code: ${code}`,
    `- message: ${message}`,
    `- round: ${request.round}`,
    `- target_root: ${request.target_root}`,
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
    adapter: "claude",
    status: "failed",
    target_root: agentState.target_root ?? request.target_root,
    last_input_file: agentState.last_input_file ?? paths.inputFile,
    last_output_file: agentState.last_output_file ?? null,
    last_error: error
  });
  await appendAgentArtifacts(agentState, [
    artifact(paths.diagnosticFile, "diagnostic", request.round, request.agent_id)
  ]);
  agentState.errors ??= [];
  agentState.errors.push({
    ...error,
    agent_id: request.agent_id,
    adapter: "claude",
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
  throw new ClaudePrepareFailedError(responsePath(input.paths), response);
}
async function failComplete(input) {
  const response = await handleFailure(input);
  return { path: responsePath(input.paths), response };
}

// src/core/claude-adapter/workflow-complete.ts
async function readNonEmptyOutput(filePath) {
  if (!await pathExists(filePath)) return null;
  const text = await readFile2(filePath, "utf8");
  return text.trim().length ? text : null;
}
async function completeClaudeRun(request, outputFile, options = {}) {
  const dataDir = options.dataDir ? normalizePath(options.dataDir) : null;
  request = normalizeRequest(request);
  outputFile = normalizePath(outputFile);
  if (!dataDir) throw new Error("--data-dir is required.");
  const requestWithDataDir = { ...request, data_dir: dataDir };
  const artifactDir = artifactDirFor(dataDir, request.review_session_id ?? "unknown");
  const paths = artifactPaths(artifactDir, request.round ?? "unknown", request.agent_id ?? "unknown");
  const validationError = await validateRequest(request);
  if (validationError) {
    return failComplete({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: validationError.code,
      message: validationError.message
    });
  }
  let sessionState;
  let agentState;
  try {
    sessionState = await readSessionState(dataDir, request.review_session_id);
    if (sessionState.review_session_id !== request.review_session_id) {
      return failComplete({
        request: requestWithDataDir,
        agentState: null,
        paths,
        code: "state_file_invalid",
        message: "session state file review_session_id does not match request."
      });
    }
    agentState = await readOrCreateAgentState(dataDir, request);
  } catch (error) {
    const caught = error;
    return failComplete({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: caught.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message: caught.code === "ENOENT" ? "session state file does not exist." : `state file is not valid JSON: ${caught.message}`
    });
  }
  if (agentState.review_session_id !== request.review_session_id || agentState.agent_id !== request.agent_id) {
    return failComplete({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Claude agent state file review_session_id or agent_id does not match request."
    });
  }
  if (outputFile !== normalizePath(paths.outputFile)) {
    return failComplete({
      request: requestWithDataDir,
      agentState,
      paths,
      code: "claude_output_missing",
      message: "output-file does not match derived Claude output path."
    });
  }
  if (!await readNonEmptyOutput(paths.outputFile)) {
    return failComplete({
      request: requestWithDataDir,
      agentState,
      paths,
      code: "claude_output_missing",
      message: "Claude output file was not created or was empty."
    });
  }
  const contextFile = agentContextFileFor(dataDir, request.review_session_id, request.agent_id);
  await writeTextFile(contextFile, buildClaudeContext({ request, sessionState, currentPaths: paths }));
  const artifacts = [
    artifact(paths.inputFile, "claude_input", request.round, request.agent_id),
    artifact(paths.outputFile, "agent_output", request.round, request.agent_id),
    artifact(paths.diagnosticFile, "diagnostic", request.round, request.agent_id)
  ];
  await writeDiagnostic(paths.diagnosticFile, [
    `# Claude adapter diagnostic`,
    ``,
    `- status: completed`,
    `- round: ${request.round}`,
    `- output_file: ${normalizePath(paths.outputFile)}`
  ]);
  await markAgentCompleted({ dataDir, request, paths, contextFile, agentState, artifacts });
  const response = makeResponse(requestWithDataDir, "completed", paths.outputFile, artifacts, null);
  await writeJsonAtomic(paths.responseFile, response);
  return { path: responsePath(paths), response };
}

// src/core/claude-adapter/workflow-prepare.ts
import { mkdir as mkdir4 } from "node:fs/promises";
async function prepareClaudeRun(request, options = {}) {
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
  await mkdir4(artifactDir, { recursive: true });
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
    const caught = error;
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: caught.code === "ENOENT" ? "state_file_missing" : "state_file_invalid",
      message: caught.code === "ENOENT" ? "session state file does not exist." : `session state file is not valid JSON: ${caught.message}`
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
      message: `Claude agent state file is not valid JSON: ${caught.message}`
    });
  }
  if (agentState.review_session_id !== request.review_session_id || agentState.agent_id !== request.agent_id) {
    return failPrepare({
      request: requestWithDataDir,
      agentState: null,
      paths,
      code: "state_file_invalid",
      message: "Claude agent state file review_session_id or agent_id does not match request."
    });
  }
  const contextFile = agentContextFileFor(dataDir, request.review_session_id, request.agent_id);
  await writeTextFile(paths.inputFile, buildClaudeInput({ request, contextFile, outputFile: paths.outputFile }));
  await writeTextFile(
    paths.diagnosticFile,
    `# Claude adapter diagnostic

- status: prepared
- round: ${request.round}
`
  );
  await writeTextFile(contextFile, buildClaudeContext({ request, sessionState, currentPaths: paths }));
  await markAgentPrepared(dataDir, request, paths, contextFile, agentState);
  return { kind: "input", path: inputPath(paths), output_file: outputPath(paths), status: "prepared" };
}

// src/runners/claude-adapter-runner.ts
async function readRequest(requestFile) {
  return JSON.parse(await readFile3(requestFile, "utf8"));
}
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
    const request = await readRequest(args.requestFile);
    try {
      const result = await prepareClaudeRun(request, { dataDir: args.dataDir });
      process.stdout.write(`${result.path}
`);
    } catch (error) {
      if (!(error instanceof ClaudePrepareFailedError)) throw error;
      process.stderr.write(`${error.name}: ${error.message}
`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.command === "complete") {
    if (!args.requestFile) throw new Error("--request is required.");
    if (!args.outputFile) throw new Error("--output-file is required.");
    const request = await readRequest(args.requestFile);
    const result = await completeClaudeRun(request, args.outputFile, { dataDir: args.dataDir });
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
