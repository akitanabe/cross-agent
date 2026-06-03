#!/usr/bin/env node

// src/runners/agent-review-runner.ts
import { resolve as resolve5 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/agent-review/cli.ts
import { readFile as readFile3 } from "node:fs/promises";
import { resolve as resolve4 } from "node:path";

// src/core/shared/cli-args.ts
function parseIntegerOption(value, optionName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${optionName} must be an integer.`);
  return number;
}
function parseBooleanOption(value, optionName) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${optionName} must be true or false.`);
}
function requireOption(args, field, optionName) {
  if (args[field] == null || args[field] === "") throw new Error(`${optionName} is required.`);
  return args[field];
}
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
  commands,
  commonOptions: commonOptions2 = {}
}) {
  const command = argv[0];
  if (command === "--help" || command === "-h") {
    return { command: null, help: true };
  }
  if (command && !commands[command]) throw new Error(`Unknown command: ${command}`);
  return parseOptionArgs(
    argv,
    { ...commonOptions2, ...commands[command]?.options ?? {} },
    {
      startIndex: 1,
      initialArgs: { command }
    }
  );
}

// src/core/agent-review/state.ts
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

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
function normalizePathList(values, platform = process.platform) {
  if (!Array.isArray(values)) return values;
  return values.map((value) => normalizePath(value, platform));
}

// src/core/shared/adapter-envelope.ts
var SUPPORTED_ADAPTER_CONTRACT_VERSION = 2;

// src/core/agent-review/state.ts
var OWNER = "agent-review";
var DEFAULT_OPTIONS = {
  auto_deep_dive: true,
  review_depth: "medium",
  keep_artifacts: false
};
var SUPPORTED_SESSION_SCHEMA_VERSION = 2;
var ADAPTER_RESPONSE_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "skipped"]);
var REVIEW_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
var AGENT_ID_RE = /^[A-Za-z0-9._-]+$/;
function validateReviewSessionId(reviewSessionId) {
  if (typeof reviewSessionId !== "string" || reviewSessionId.length === 0) {
    throw new Error("review_session_id must be a non-empty string.");
  }
  if (!REVIEW_SESSION_ID_RE.test(reviewSessionId) || reviewSessionId.includes("..")) {
    throw new Error(`invalid review_session_id: ${reviewSessionId}`);
  }
}
function validateRoundNumber(round) {
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) {
    throw new Error(`invalid round: ${round}`);
  }
}
function validateAgentId(agentId) {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new Error("agent_id must be a non-empty string.");
  }
  if (!AGENT_ID_RE.test(agentId) || agentId.includes("..") || agentId.includes("=")) {
    throw new Error(`invalid agent_id: ${agentId}`);
  }
}
function parseAgentLaunchSpec(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator !== value.lastIndexOf("=") || separator === value.length - 1) {
    throw new Error(`invalid --agents value: ${value}. Expected <agent_id>=<adapter>.`);
  }
  const agent_id = value.slice(0, separator);
  const adapter = value.slice(separator + 1);
  validateAgentId(agent_id);
  if (!adapter) throw new Error(`invalid adapter for agent_id ${agent_id}.`);
  return { agent_id, adapter };
}
function normalizeAgentLaunchSpecs(input) {
  const hasAgents = input.agents !== void 0 && input.agents !== null;
  const hasSingle = input.agent_id != null || input.adapter != null;
  if (hasAgents && hasSingle) {
    throw new Error("--agents cannot be combined with --agent-id/--adapter.");
  }
  let agents;
  if (hasAgents) {
    agents = input.agents ?? [];
    if (agents.length === 0) throw new Error("agents must include at least one entry.");
  } else if (hasSingle) {
    if (!input.agent_id || !input.adapter) {
      throw new Error("--agent-id and --adapter must be specified together.");
    }
    agents = [{ agent_id: input.agent_id, adapter: input.adapter }];
  } else {
    agents = [{ agent_id: "codex", adapter: "codex" }];
  }
  const seen = /* @__PURE__ */ new Set();
  for (const spec of agents) {
    validateAgentId(spec.agent_id);
    if (!spec.adapter) throw new Error(`adapter is required for agent_id ${spec.agent_id}.`);
    if (seen.has(spec.agent_id)) throw new Error(`duplicate agent_id in round: ${spec.agent_id}`);
    seen.add(spec.agent_id);
  }
  return agents;
}
function isPathInside(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  if (parentPath === childPath) return true;
  const rel = relative(parentPath, childPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  await rename(tmp, filePath);
}
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
function validateSessionStateSchema(state) {
  if (state.schema_version !== SUPPORTED_SESSION_SCHEMA_VERSION) {
    throw new Error(
      `unsupported agent-review session schema_version ${state.schema_version ?? "missing"}; expected ${SUPPORTED_SESSION_SCHEMA_VERSION}.`
    );
  }
}
function resolveDataDir(inputDataDir) {
  if (!inputDataDir) {
    throw new Error(
      'data_dir is required. In plugin context, pass `--data-dir "${CLAUDE_PLUGIN_DATA}"` (Claude Code substitutes this in skill content).'
    );
  }
  return normalizePath(inputDataDir);
}
async function ensureDirectory(path, label) {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    const nodeError = error;
    if (nodeError.code === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
    throw error;
  }
}
function sessionPaths(dataDir, reviewSessionId) {
  validateReviewSessionId(reviewSessionId);
  const sessionsDir = resolve(dataDir, "sessions");
  const sessionDir = resolve(sessionsDir, reviewSessionId);
  const artifactDir = resolve(dataDir, "artifacts", reviewSessionId);
  return {
    sessionsDir,
    sessionDir,
    artifactDir,
    stateFile: resolve(sessionsDir, `${reviewSessionId}.json`)
  };
}
function artifact(path, kind, round = null, agentId = null, adapter = null) {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent_id: agentId,
    adapter,
    created_at: nowIso(),
    temporary: false
  };
}
function normalizeOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options
  };
}

// src/core/agent-review/workflow-common.ts
function commandOutput(outputType, content) {
  return { output_type: outputType, content };
}
async function readSession(dataDir, reviewSessionId) {
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const paths = sessionPaths(dataDir, reviewSessionId);
  const state = await readJson(paths.stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }
  validateSessionStateSchema(state);
  return { paths, state };
}

// src/core/agent-review/workflow-complete.ts
import { stat as stat2 } from "node:fs/promises";
import { resolve as resolve2 } from "node:path";
async function validateExistingFile(filePath, label) {
  let entry;
  try {
    entry = await stat2(filePath);
  } catch (error) {
    const nodeError = error;
    if (nodeError.code === "ENOENT") {
      throw new Error(`invalid adapter response: ${label} does not exist: ${filePath}`);
    }
    throw error;
  }
  if (!entry.isFile()) {
    throw new Error(`invalid adapter response: ${label} is not a file: ${filePath}`);
  }
}
async function validateAdapterResponse(response, paths, responseFile = null) {
  if (response.contract_version !== SUPPORTED_ADAPTER_CONTRACT_VERSION) {
    throw new Error(`invalid adapter response: unsupported contract_version ${response.contract_version}`);
  }
  if (!ADAPTER_RESPONSE_STATUSES.has(response.status)) {
    throw new Error(`invalid adapter response: unknown status ${response.status}`);
  }
  validateRoundNumber(response.round);
  validateAgentId(response.agent_id);
  if (!response.adapter) throw new Error("invalid adapter response: adapter is required.");
  if (responseFile) {
    if (!isPathInside(paths.artifactDir, responseFile)) {
      throw new Error(`invalid adapter response: response_file is outside artifact dir: ${responseFile}`);
    }
    await validateExistingFile(responseFile, "response_file");
  }
  if (response.status === "completed") {
    if (typeof response.output_file !== "string" || response.output_file.length === 0) {
      throw new Error("invalid adapter response: completed requires output_file");
    }
    if (!isPathInside(paths.artifactDir, response.output_file)) {
      throw new Error(`invalid adapter response: output_file is outside artifact dir: ${response.output_file}`);
    }
    await validateExistingFile(response.output_file, "output_file");
  } else if (response.output_file != null) {
    throw new Error(`invalid adapter response: ${response.status} must not include output_file`);
  }
}
async function resolveAdapterResponseInput(input, dataDir) {
  if (!input.response_file) throw new Error("response_file is required.");
  const responseFile = normalizePath(input.response_file);
  const artifactRoot = resolve2(dataDir, "artifacts");
  if (!isPathInside(artifactRoot, responseFile)) {
    throw new Error(`invalid adapter response: response_file is outside artifact root: ${responseFile}`);
  }
  const response = await readJson(responseFile);
  return { response, responseFile };
}
async function completeResolvedRound({
  dataDir,
  agentResponse,
  responseFile,
  expected
}) {
  const reviewSessionId = agentResponse.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  if (expected) {
    if (reviewSessionId !== expected.reviewSessionId) {
      throw new Error("adapter response review_session_id does not match current round.");
    }
    if (agentResponse.round !== expected.round || agentResponse.agent_id !== expected.agentId) {
      throw new Error(`adapter response does not match current round: ${expected.round}/${expected.agentId}`);
    }
  }
  const paths = sessionPaths(dataDir, reviewSessionId);
  await validateAdapterResponse(agentResponse, paths, responseFile);
  const state = await readJson(paths.stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }
  validateSessionStateSchema(state);
  const round = state.rounds?.find((entry) => entry.round === agentResponse.round);
  const agentState = round?.agents.find((entry) => entry.agent_id === agentResponse.agent_id);
  if (!round || !agentState) {
    throw new Error(`agent state not found: round ${agentResponse.round}, agent_id ${agentResponse.agent_id}`);
  }
  if (agentState.adapter !== agentResponse.adapter) {
    throw new Error(
      `adapter response adapter does not match state for ${agentResponse.agent_id}: ${agentState.adapter} != ${agentResponse.adapter}`
    );
  }
  const completedAt = nowIso();
  agentState.completed_at = completedAt;
  agentState.status = agentResponse.status;
  agentState.agent_result = {
    agent_id: agentResponse.agent_id,
    adapter: agentResponse.adapter,
    round: agentResponse.round,
    status: agentResponse.status,
    output_file: normalizePath(agentResponse.output_file ?? null),
    error: agentResponse.error
  };
  if (round.agents.every((entry) => entry.status !== "pending")) {
    round.completed_at = completedAt;
  }
  state.updated_at = nowIso();
  await writeJsonAtomic(paths.stateFile, state);
  return {
    review_session_id: state.review_session_id,
    state_file: paths.stateFile,
    round: agentResponse.round,
    agent_id: agentResponse.agent_id,
    adapter: agentResponse.adapter,
    status: agentResponse.status,
    response_file: responseFile
  };
}
async function completeRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const { response: agentResponse, responseFile } = await resolveAdapterResponseInput(input, dataDir);
  return completeResolvedRound({ dataDir, agentResponse, responseFile });
}
async function completeCurrentRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const { paths, state } = await readSession(dataDir, reviewSessionId);
  validateRoundNumber(state.current_round);
  const currentRound = (state.rounds ?? []).find((entry) => entry.round === state.current_round);
  if (!currentRound) throw new Error(`current round is missing: ${state.current_round}`);
  const pendingAgents = currentRound.agents.filter((entry) => entry.status === "pending");
  if (pendingAgents.length !== 1) {
    throw new Error(`current round pending agent is ambiguous or missing: ${state.current_round}`);
  }
  const pendingAgent = pendingAgents[0];
  const responseFile = normalizePath(pendingAgent.response_file);
  if (!isPathInside(paths.artifactDir, responseFile)) {
    throw new Error(`invalid adapter response: derived response_file is outside artifact dir: ${responseFile}`);
  }
  const agentResponse = await readJson(responseFile);
  return completeResolvedRound({
    dataDir,
    agentResponse,
    responseFile,
    expected: {
      reviewSessionId,
      round: currentRound.round,
      agentId: pendingAgent.agent_id
    }
  });
}

// src/core/agent-review/workflow-prepare.ts
import { writeFile as writeFile2 } from "node:fs/promises";
import { resolve as resolve3 } from "node:path";

// src/core/agent-review/envelope.ts
function buildAdapterRequest({
  reviewSessionId,
  agentId,
  adapter,
  round,
  roundKind,
  targetRoot,
  promptFile,
  contextFile = null,
  targetFiles = [],
  focusQuestion = null,
  options
}) {
  return {
    contract_version: 2,
    review_session_id: reviewSessionId,
    agent_id: agentId,
    adapter,
    round,
    round_kind: roundKind,
    target_root: normalizePath(targetRoot),
    prompt_file: normalizePath(promptFile),
    context_file: normalizePath(contextFile),
    target_files: normalizePathList(targetFiles),
    focus_question: focusQuestion,
    options: {
      review_depth: options.review_depth,
      timeout_seconds: options.timeout_seconds ?? null
    }
  };
}

// src/core/agent-review/prompts.ts
function buildInitialPrompt({
  focusQuestion,
  contextFile,
  targetFiles = []
}) {
  const sections = [
    "\u3042\u306A\u305F\u306F\u72EC\u7ACB\u3057\u305F\u30B7\u30CB\u30A2\u30A8\u30F3\u30B8\u30CB\u30A2\u3067\u3059\u3002\u4EE5\u4E0B\u306E\u60C5\u5831\u3092\u8AAD\u307F\u3001\u6279\u5224\u7684\u30FB\u5EFA\u8A2D\u7684\u306A\u30BB\u30AB\u30F3\u30C9\u30AA\u30D4\u30CB\u30AA\u30F3\u3092\u63D0\u4F9B\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
  ];
  if (focusQuestion) {
    sections.push(`## \u30D5\u30A9\u30FC\u30AB\u30B9\u8CEA\u554F
${focusQuestion}`);
  }
  if (contextFile) {
    sections.push(`## \u30B3\u30F3\u30C6\u30AD\u30B9\u30C8\u30D5\u30A1\u30A4\u30EB
${contextFile}`);
  }
  if (targetFiles.length) {
    sections.push(`## \u30EC\u30D3\u30E5\u30FC\u5BFE\u8C61\u30D5\u30A1\u30A4\u30EB
${targetFiles.join("\n")}

\u5FC5\u8981\u306B\u5FDC\u3058\u3066\u95A2\u9023\u30D5\u30A1\u30A4\u30EB\u3082\u53C2\u7167\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
  }
  sections.push(`## \u30EC\u30D3\u30E5\u30FC\u89B3\u70B9
- \u898B\u843D\u3068\u3057\u3066\u3044\u308B\u30EA\u30B9\u30AF\u3084\u554F\u984C\u70B9
- \u3088\u308A\u826F\u3044\u30A2\u30D7\u30ED\u30FC\u30C1\u3084\u4EE3\u66FF\u6848
- \u5168\u4F53\u7684\u306A\u8A2D\u8A08\u30FB\u5224\u65AD\u306E\u59A5\u5F53\u6027
- \u5B9F\u88C5\u4E0A\u306E\u6CE8\u610F\u70B9
- \u30C6\u30B9\u30C8\u89B3\u70B9`);
  return `${sections.join("\n\n")}
`;
}
function buildNextRoundPrompt({
  promptText,
  previousOutputFile = null,
  focusQuestion = null
}) {
  if (!promptText) throw new Error("prompt_text is required.");
  const sections = ["\u3042\u306A\u305F\u306F\u540C\u3058\u30EC\u30D3\u30E5\u30FC\u30BB\u30C3\u30B7\u30E7\u30F3\u3092\u7D99\u7D9A\u3057\u3066\u3044\u307E\u3059\u3002\u4EE5\u4E0B\u306E\u8FFD\u52A0\u4F9D\u983C\u306B\u3060\u3051\u7B54\u3048\u3066\u304F\u3060\u3055\u3044\u3002"];
  if (previousOutputFile) {
    sections.push(`## \u524D\u56DE round \u306E\u51FA\u529B
${previousOutputFile}`);
  }
  if (focusQuestion) {
    sections.push(`## \u30D5\u30A9\u30FC\u30AB\u30B9\u8CEA\u554F
${focusQuestion}`);
  }
  sections.push(`## \u8FFD\u52A0\u4F9D\u983C
${promptText}`);
  sections.push(`## \u51FA\u529B\u65B9\u91DD
- \u524D\u56DE round \u306E\u5358\u306A\u308B\u7E70\u308A\u8FD4\u3057\u306F\u907F\u3051\u308B
- \u65B0\u3057\u304F\u78BA\u4FE1\u5EA6\u304C\u4E0A\u304C\u3063\u305F\u70B9\u3001\u4E0B\u304C\u3063\u305F\u70B9\u3092\u660E\u793A\u3059\u308B
- \u63A1\u7528\u3059\u3079\u304D\u5BFE\u5FDC\u3001\u4FDD\u7559\u3059\u3079\u304D\u5BFE\u5FDC\u3001\u8FFD\u52A0\u8ABF\u67FB\u304C\u5FC5\u8981\u306A\u70B9\u3092\u5206\u3051\u308B`);
  return `${sections.join("\n\n")}
`;
}

// src/core/agent-review/workflow-prepare.ts
function responseFileFor(paths, round, agentId) {
  return normalizePath(resolve3(paths.artifactDir, `round-${round}-${agentId}-response.json`));
}
async function writeAgentRequest({
  paths,
  state,
  reviewSessionId,
  spec,
  round,
  roundKind,
  promptText,
  contextFile,
  targetFiles,
  focusQuestion
}) {
  const promptFile = normalizePath(resolve3(paths.artifactDir, `round-${round}-${spec.agent_id}-prompt.md`));
  await writeFile2(promptFile, promptText, "utf8");
  const envelope = buildAdapterRequest({
    reviewSessionId,
    agentId: spec.agent_id,
    adapter: spec.adapter,
    round,
    roundKind,
    targetRoot: state.target_root,
    promptFile,
    contextFile: normalizePath(contextFile),
    targetFiles,
    focusQuestion,
    options: state.options
  });
  const requestFile = normalizePath(
    resolve3(paths.artifactDir, `round-${round}-${spec.agent_id}-adapter-request.json`)
  );
  await writeJsonAtomic(requestFile, envelope);
  const now = nowIso();
  return {
    agentState: {
      agent_id: spec.agent_id,
      adapter: spec.adapter,
      status: "pending",
      prompt_file: promptFile,
      adapter_request_file: requestFile,
      response_file: responseFileFor(paths, round, spec.agent_id),
      started_at: now,
      completed_at: null,
      agent_result: null
    },
    request: {
      agent_id: spec.agent_id,
      adapter: spec.adapter,
      request_file: requestFile
    },
    envelope
  };
}
async function prepareRound({
  paths,
  state,
  reviewSessionId,
  agents,
  round,
  roundKind,
  promptText,
  contextFile,
  targetFiles,
  focusQuestion,
  resetRounds = false,
  extraArtifacts = [],
  updateState = null
}) {
  const prepared = [];
  for (const spec of agents) {
    prepared.push(
      await writeAgentRequest({
        paths,
        state,
        reviewSessionId,
        spec,
        round,
        roundKind,
        promptText,
        contextFile,
        targetFiles,
        focusQuestion
      })
    );
  }
  const now = nowIso();
  state.updated_at = now;
  state.current_round = round;
  updateState?.({ promptFile: prepared[0]?.agentState.prompt_file ?? "", now });
  const roundEntry = {
    round,
    kind: roundKind,
    started_at: now,
    completed_at: null,
    agents: prepared.map((entry) => entry.agentState)
  };
  if (resetRounds) {
    state.rounds = [roundEntry];
  } else {
    state.rounds ??= [];
    const existing = state.rounds.find((entry) => entry.round === round);
    if (existing) {
      const existingIds = new Set(existing.agents.map((agent) => agent.agent_id));
      for (const agentState of roundEntry.agents) {
        if (existingIds.has(agentState.agent_id))
          throw new Error(`duplicate agent_id in round: ${agentState.agent_id}`);
      }
      existing.agents.push(...roundEntry.agents);
    } else {
      state.rounds.push(roundEntry);
    }
  }
  state.artifacts ??= { files: [] };
  state.artifacts.files ??= [];
  state.artifacts.files.push(
    ...extraArtifacts,
    ...prepared.flatMap((entry) => [
      artifact(entry.agentState.prompt_file, "prompt", round, entry.agentState.agent_id, entry.agentState.adapter),
      artifact(
        entry.agentState.adapter_request_file,
        "adapter_request",
        round,
        entry.agentState.agent_id,
        entry.agentState.adapter
      )
    ])
  );
  await writeJsonAtomic(paths.stateFile, state);
  const requests = prepared.map((entry) => entry.request);
  return {
    ...commandOutput("json", { review_session_id: reviewSessionId, round, requests }),
    requests,
    envelopes: prepared.map((entry) => entry.envelope)
  };
}
async function prepareInitialRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const { paths, state } = await readSession(dataDir, reviewSessionId);
  const agents = normalizeAgentLaunchSpecs(input);
  const targetFiles = normalizePathList(input.target_files ?? []);
  const focusQuestion = input.focus_question ?? null;
  const contextText = input.context_text ?? null;
  const source = input.source ?? (contextText && targetFiles.length ? "mixed" : contextText ? "conversation" : "files");
  let contextFile = null;
  const artifacts = [];
  if (contextText) {
    contextFile = resolve3(paths.artifactDir, "context.md");
    const normalizedContextFile = normalizePath(contextFile);
    await writeFile2(contextFile, contextText.endsWith("\n") ? contextText : `${contextText}
`, "utf8");
    artifacts.push(artifact(normalizedContextFile, "context"));
    contextFile = normalizedContextFile;
  }
  const promptText = buildInitialPrompt({ focusQuestion, contextFile, targetFiles });
  return prepareRound({
    paths,
    state,
    reviewSessionId,
    agents,
    round: 1,
    roundKind: "initial_review",
    promptText,
    contextFile,
    targetFiles,
    focusQuestion,
    resetRounds: true,
    extraArtifacts: artifacts,
    updateState: ({ promptFile }) => {
      state.context = {
        context_file: contextFile,
        initial_prompt_file: promptFile,
        focus_question: focusQuestion,
        target_files: targetFiles,
        source
      };
    }
  });
}
function completedAgentForKind(previousRound, spec) {
  const previousAgent = previousRound.agents.find((agent) => agent.agent_id === spec.agent_id);
  if (!previousAgent) {
    throw new Error(`previous round has no agent_id ${spec.agent_id}.`);
  }
  return previousAgent;
}
function previousOutputForFollowUp({
  previousRound,
  previousAgentId
}) {
  if (previousAgentId) {
    const agent = previousRound.agents.find((entry) => entry.agent_id === previousAgentId);
    if (!agent) throw new Error(`previous round has no previous_agent_id ${previousAgentId}.`);
    return agent.agent_result?.output_file ?? null;
  }
  const agentsWithOutput = previousRound.agents.filter((agent) => agent.agent_result?.output_file);
  if (agentsWithOutput.length > 1) {
    throw new Error("previous output is ambiguous; specify previous_agent_id.");
  }
  return agentsWithOutput[0]?.agent_result?.output_file ?? null;
}
async function prepareNextRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const { paths, state } = await readSession(dataDir, reviewSessionId);
  if (state.status !== "active") {
    throw new Error(`session is not active: ${state.status}`);
  }
  const rounds = state.rounds ?? [];
  if (input.previous_round !== void 0) validateRoundNumber(input.previous_round);
  const previousRound = input.previous_round !== void 0 ? rounds.find((entry) => entry.round === input.previous_round) : rounds.slice().reverse()[0];
  if (!previousRound) throw new Error("previous round not found.");
  const agents = input.agent_id != null || input.adapter != null || input.agents != null ? normalizeAgentLaunchSpecs(input) : previousRound.agents.length === 1 ? [{ agent_id: previousRound.agents[0].agent_id, adapter: previousRound.agents[0].adapter }] : (() => {
    throw new Error("previous round has multiple agents; specify --agent-id/--adapter or --agents.");
  })();
  const roundKind = input.round_kind ?? "follow_up";
  for (const spec of agents) {
    if (roundKind !== "deep_dive" && roundKind !== "recovery") continue;
    const previousAgent = completedAgentForKind(previousRound, spec);
    const previousResult = previousAgent.agent_result;
    if (!previousResult) {
      throw new Error(`previous round is not completed for agent_id ${spec.agent_id}.`);
    }
    if (roundKind === "deep_dive" && previousResult?.status !== "completed") {
      throw new Error(
        `deep_dive requires previous status=completed for agent_id ${spec.agent_id}, got ${previousResult?.status}`
      );
    }
    if (roundKind === "recovery" && previousResult?.status !== "failed") {
      throw new Error(
        `recovery requires previous status=failed for agent_id ${spec.agent_id}, got ${previousResult?.status}`
      );
    }
  }
  const focusQuestion = input.focus_question ?? state.context?.focus_question ?? null;
  const targetFiles = normalizePathList(input.target_files ?? state.context?.target_files ?? []);
  const contextFile = state.context?.context_file ?? null;
  const nextRound = Math.max(0, ...rounds.map((entry) => entry.round)) + 1;
  const previousOutputFile = previousOutputForFollowUp({
    previousRound,
    previousAgentId: input.previous_agent_id ?? null
  });
  const promptText = buildNextRoundPrompt({
    promptText: input.prompt_text,
    previousOutputFile,
    focusQuestion
  });
  return prepareRound({
    paths,
    state,
    reviewSessionId,
    agents,
    round: nextRound,
    roundKind,
    promptText,
    contextFile,
    targetFiles,
    focusQuestion
  });
}

// src/core/agent-review/workflow-round.ts
import { readFile as readFile2 } from "node:fs/promises";
async function getRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");
  const { state } = await readSession(dataDir, reviewSessionId);
  const rounds = state.rounds ?? [];
  if (input.round !== void 0) validateRoundNumber(input.round);
  if (input.agent_id) validateAgentId(input.agent_id);
  const selectedRound = input.round !== void 0 ? rounds.find((entry) => entry.round === input.round) : rounds.slice().reverse().find((entry) => entry.agents.some((agent) => agent.agent_result?.output_file));
  if (!selectedRound) throw new Error("round not found.");
  let selectedAgent;
  if (input.agent_id) {
    selectedAgent = selectedRound.agents.find((agent) => agent.agent_id === input.agent_id);
    if (!selectedAgent) throw new Error(`agent_id not found in round ${selectedRound.round}: ${input.agent_id}`);
  } else {
    const agentsWithOutput = selectedRound.agents.filter((agent) => agent.agent_result?.output_file);
    if (agentsWithOutput.length !== 1) {
      throw new Error(`round output is ambiguous or missing: ${selectedRound.round}`);
    }
    selectedAgent = agentsWithOutput[0];
  }
  const result = selectedAgent.agent_result;
  if (!result) throw new Error(`round is not completed: ${selectedRound.round}/${selectedAgent.agent_id}`);
  return {
    review_session_id: state.review_session_id,
    round: selectedRound.round,
    agent_id: selectedAgent.agent_id,
    adapter: selectedAgent.adapter,
    status: result.status,
    output_file: result.output_file,
    error: result.error
  };
}
async function getRoundOutput(input) {
  const round = await getRound(input);
  if (!round.output_file) throw new Error(`round has no output_file: ${round.round}/${round.agent_id}`);
  return commandOutput("text", await readFile2(round.output_file, "utf8"));
}

// src/core/agent-review/workflow-session.ts
import { randomUUID } from "node:crypto";
import { mkdir as mkdir2 } from "node:fs/promises";
async function startSession(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const targetRoot = normalizePath(input.target_root);
  if (!targetRoot) throw new Error("target_root is required.");
  await ensureDirectory(targetRoot, "target_root");
  const reviewSessionId = input.review_session_id ?? randomUUID();
  const paths = sessionPaths(dataDir, reviewSessionId);
  await mkdir2(paths.sessionsDir, { recursive: true });
  await mkdir2(paths.artifactDir, { recursive: true });
  const options = normalizeOptions(input.options);
  const createdAt = nowIso();
  const state = {
    schema_version: SUPPORTED_SESSION_SCHEMA_VERSION,
    review_session_id: reviewSessionId,
    created_at: createdAt,
    updated_at: createdAt,
    status: "active",
    target_root: targetRoot,
    current_round: 0,
    options,
    context: {
      context_file: null,
      initial_prompt_file: null,
      focus_question: null,
      target_files: [],
      source: "files"
    },
    rounds: [],
    artifacts: {
      files: []
    },
    errors: []
  };
  await writeJsonAtomic(paths.stateFile, state);
  return commandOutput("text", reviewSessionId);
}

// src/core/agent-review/cli.ts
function optionInput(args) {
  const options = {};
  if (args.reviewDepth != null) options.review_depth = args.reviewDepth;
  if (args.autoDeepDive != null) options.auto_deep_dive = args.autoDeepDive;
  return Object.keys(options).length ? options : void 0;
}
async function readOptionalTextFile(filePath) {
  if (!filePath) return null;
  return readFile3(filePath, "utf8");
}
async function readTextFileIfExists(filePath) {
  try {
    return await readFile3(filePath, "utf8");
  } catch (error) {
    const nodeError = error;
    if (nodeError.code === "ENOENT") return null;
    throw error;
  }
}
function commonInput(args) {
  return { data_dir: requireOption(args, "dataDir", "--data-dir") };
}
async function readPrepareInitialContext(args) {
  if (args.contextFile) return readOptionalTextFile(args.contextFile);
  const dataDir = requireOption(args, "dataDir", "--data-dir");
  const reviewSessionId = requireOption(args, "reviewSessionId", "--review-session-id");
  const defaultContextFile = resolve4(sessionPaths(dataDir, reviewSessionId).artifactDir, "context.md");
  return readTextFileIfExists(defaultContextFile);
}
var commonOptions = {
  "--data-dir": { field: "dataDir" }
};
var commandArgs = {
  "start-session": {
    usage: "start-session --data-dir <CLAUDE_PLUGIN_DATA> --target-root <root> [--review-session-id <id>] [--review-depth <level>] [--auto-deep-dive <true|false>]",
    options: {
      "--target-root": { field: "targetRoot" },
      "--review-session-id": { field: "reviewSessionId" },
      "--review-depth": { field: "reviewDepth" },
      "--auto-deep-dive": { field: "autoDeepDive", parse: parseBooleanOption }
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: args.reviewSessionId,
      target_root: requireOption(args, "targetRoot", "--target-root"),
      options: optionInput(args)
    }),
    run: (input) => startSession(input)
  },
  "prepare-initial": {
    usage: "prepare-initial --data-dir <CLAUDE_PLUGIN_DATA> --review-session-id <id> [--agent-id <id> --adapter <adapter> | --agents <id=adapter...>] [--focus-question <text>] [--context-file <path>] [--target-files <file...>]",
    options: {
      "--review-session-id": { field: "reviewSessionId" },
      "--agent-id": { field: "agentId" },
      "--adapter": { field: "adapter" },
      "--agents": { field: "agents", multiple: true },
      "--focus-question": { field: "focusQuestion" },
      "--context-file": { field: "contextFile" },
      "--target-files": { field: "targetFiles", multiple: true }
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: requireOption(args, "reviewSessionId", "--review-session-id"),
      agent_id: args.agentId,
      adapter: args.adapter,
      agents: args.agents?.map(parseAgentLaunchSpec),
      focus_question: args.focusQuestion,
      context_text: await readPrepareInitialContext(args),
      target_files: args.targetFiles ?? []
    }),
    run: (input) => prepareInitialRound(input)
  },
  "prepare-next-round": {
    usage: "prepare-next-round --data-dir <CLAUDE_PLUGIN_DATA> --review-session-id <id> --prompt-file <path> [--agent-id <id> --adapter <adapter> | --agents <id=adapter...>] [--round-kind <kind>] [--previous-round <n>] [--previous-agent-id <id>] [--focus-question <text>] [--target-files <file...>]",
    options: {
      "--review-session-id": { field: "reviewSessionId" },
      "--agent-id": { field: "agentId" },
      "--adapter": { field: "adapter" },
      "--agents": { field: "agents", multiple: true },
      "--round-kind": { field: "roundKind" },
      "--prompt-file": { field: "promptFile" },
      "--previous-round": { field: "previousRound", parse: parseIntegerOption },
      "--previous-agent-id": { field: "previousAgentId" },
      "--focus-question": { field: "focusQuestion" },
      "--target-files": { field: "targetFiles", multiple: true }
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: requireOption(args, "reviewSessionId", "--review-session-id"),
      agent_id: args.agentId,
      adapter: args.adapter,
      agents: args.agents?.map(parseAgentLaunchSpec),
      round_kind: args.roundKind,
      prompt_text: await readOptionalTextFile(requireOption(args, "promptFile", "--prompt-file")),
      previous_round: args.previousRound,
      previous_agent_id: args.previousAgentId,
      focus_question: args.focusQuestion,
      target_files: args.targetFiles
    }),
    run: (input) => prepareNextRound(input)
  },
  "complete-round": {
    usage: "complete-round --data-dir <CLAUDE_PLUGIN_DATA> --response-file <response-envelope.json>",
    options: {
      "--response-file": { field: "responseFile" }
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      response_file: requireOption(args, "responseFile", "--response-file")
    }),
    run: async (input) => commandOutput("json", await completeRound(input))
  },
  "complete-current-round": {
    usage: "complete-current-round --data-dir <CLAUDE_PLUGIN_DATA> --review-session-id <id>",
    options: {
      "--review-session-id": { field: "reviewSessionId" }
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: requireOption(args, "reviewSessionId", "--review-session-id")
    }),
    run: async (input) => commandOutput("json", await completeCurrentRound(input))
  },
  "get-round-output": {
    usage: "get-round-output --data-dir <CLAUDE_PLUGIN_DATA> --review-session-id <id> [--round <n>] [--agent-id <id>]",
    options: {
      "--review-session-id": { field: "reviewSessionId" },
      "--round": { field: "round", parse: parseIntegerOption },
      "--agent-id": { field: "agentId" }
    },
    buildInput: async (args) => ({
      ...commonInput(args),
      review_session_id: requireOption(args, "reviewSessionId", "--review-session-id"),
      round: args.round,
      agent_id: args.agentId
    }),
    run: (input) => getRoundOutput(input)
  }
};
function parseArgs(argv) {
  return parseCommandArgs(argv, { commands: commandArgs, commonOptions });
}
function commandFor(name) {
  return commandArgs[name];
}
function usage() {
  return `Usage:
${Object.values(commandArgs).map((command) => `  node scripts/agent-review-runner.mjs ${command.usage}`).join("\n")}`;
}

// src/runners/agent-review-runner.ts
function writeCommandOutput(result) {
  if (result.output_type === "text") {
    const text = String(result.content ?? "");
    process.stdout.write(text.endsWith("\n") ? text : `${text}
`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.content, null, 2)}
`);
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${usage()}
`);
    return;
  }
  const command = commandFor(args.command);
  if (!command) throw new Error(`Unknown command: ${args.command}`);
  const input = await command.buildInput(args);
  const result = await command.run(input);
  writeCommandOutput(result);
}
var invokedPath = process.argv[1] ? resolve5(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const caught = error;
    process.stderr.write(`${caught.stack ?? caught.message}
`);
    process.exitCode = 1;
  });
}
