#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "cross-agent";
const DEFAULT_OPTIONS = {
  max_rounds: 2,
  auto_deep_dive: true,
  review_depth: "medium",
  keep_artifacts: false,
};

// state や artifact に記録する現在時刻を ISO 文字列で返す。
function nowIso() {
  return new Date().toISOString();
}

// JSON を一時ファイルへ書いてから rename し、対象ファイルを atomic に更新する。
async function writeJsonAtomic(filePath, value) {
  // state 更新中に落ちても JSON が半端に壊れないようにする。
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

// JSON ファイルを読み込み、オブジェクトとして返す。
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

// 指定パスが存在し、ディレクトリであることを検証する。
async function ensureDirectory(path, label) {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
    throw error;
  }
}

// data directory と review_session_id から session/state/artifact のパスを組み立てる。
export function sessionPaths(dataDir, reviewSessionId) {
  // plugin root ではなく、永続 data store 配下に session と artifact をまとめる。
  const sessionsDir = resolve(dataDir, "sessions");
  const artifactDir = resolve(dataDir, "artifacts", reviewSessionId);
  return {
    sessionsDir,
    artifactDir,
    stateFile: resolve(sessionsDir, `${reviewSessionId}.json`),
  };
}

// state に append する cross-agent 生成 artifact metadata を作る。
function artifact(path, kind, round = null, agent = null) {
  // cross-agent が作った artifact だけ owner=cross-agent として記録する。
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

// 省略された cross-agent option を既定値で補完する。
export function normalizeOptions(options = {}) {
  // Skill 側が省略した値を、state に残る安定した既定値へそろえる。
  return {
    ...DEFAULT_OPTIONS,
    ...options,
  };
}

// 初回レビュー用の定型 prompt 本文を組み立てる。
export function buildInitialPrompt({ focusQuestion, contextFile, targetFiles = [] }) {
  // 会話要約そのものは Skill 側で作り、この関数は定型レビュー依頼だけを組み立てる。
  const sections = [
    "あなたは独立したシニアエンジニアです。以下の情報を読み、批判的・建設的なセカンドオピニオンを提供してください。",
  ];

  if (focusQuestion) {
    sections.push(`## フォーカス質問\n${focusQuestion}`);
  }

  if (contextFile) {
    sections.push(`## コンテキストファイル\n${contextFile}`);
  }

  if (targetFiles.length) {
    sections.push(`## レビュー対象ファイル\n${targetFiles.join("\n")}\n\n必要に応じて関連ファイルも参照してください。`);
  }

  sections.push(`## レビュー観点
- 見落としているリスクや問題点
- より良いアプローチや代替案
- 全体的な設計・判断の妥当性
- 実装上の注意点
- テスト観点`);

  return `${sections.join("\n\n")}\n`;
}

// adapter に渡す request envelope v1 を組み立てる。
export function buildAdapterRequest({
  reviewSessionId,
  agent,
  round,
  roundKind,
  targetRoot,
  stateFile,
  promptFile,
  contextFile = null,
  targetFiles = [],
  focusQuestion = null,
  options,
}) {
  // adapter 境界は v1 envelope に固定し、agent 固有の解釈は adapter 側へ任せる。
  return {
    contract_version: 1,
    review_session_id: reviewSessionId,
    agent,
    round,
    round_kind: roundKind,
    target_root: targetRoot,
    state_file: stateFile,
    prompt_file: promptFile,
    context_file: contextFile,
    target_files: targetFiles,
    focus_question: focusQuestion,
    options: {
      review_depth: options.review_depth,
      timeout_seconds: options.timeout_seconds ?? null,
    },
  };
}

// 初回 round に必要な state、artifact、prompt、adapter request を作成する。
export async function prepareInitialSession(input) {
  // 初回実行で必要な state、artifact、adapter request を一括で作る。
  const dataDir = input.data_dir ?? process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) throw new Error("data_dir or CLAUDE_PLUGIN_DATA is required.");

  const agent = input.agent ?? "codex";
  const targetRoot = input.target_root;
  if (!targetRoot) throw new Error("target_root is required.");
  await ensureDirectory(targetRoot, "target_root");

  const reviewSessionId = input.review_session_id ?? randomUUID();
  const paths = sessionPaths(dataDir, reviewSessionId);
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.artifactDir, { recursive: true });

  const options = normalizeOptions(input.options);
  const targetFiles = input.target_files ?? [];
  const focusQuestion = input.focus_question ?? null;
  const contextText = input.context_text ?? null;
  const source = input.source ?? (contextText && targetFiles.length ? "mixed" : contextText ? "conversation" : "files");

  let contextFile = null;
  const artifacts = [];
  if (contextText) {
    // context_text はすでに要約済みの入力として扱い、ここでは保存だけ行う。
    contextFile = resolve(paths.artifactDir, "context.md");
    await writeFile(contextFile, contextText.endsWith("\n") ? contextText : `${contextText}\n`, "utf8");
    artifacts.push(artifact(contextFile, "context"));
  }

  const promptFile = resolve(paths.artifactDir, "round-1-prompt.md");
  const promptText = buildInitialPrompt({ focusQuestion, contextFile, targetFiles });
  await writeFile(promptFile, promptText, "utf8");
  artifacts.push(artifact(promptFile, "prompt", 1, agent));

  const adapterRequest = buildAdapterRequest({
    reviewSessionId,
    agent,
    round: 1,
    roundKind: "initial_review",
    targetRoot,
    stateFile: paths.stateFile,
    promptFile,
    contextFile,
    targetFiles,
    focusQuestion,
    options,
  });

  const adapterRequestFile = resolve(paths.artifactDir, "round-1-adapter-request.json");
  await writeJsonAtomic(adapterRequestFile, adapterRequest);
  artifacts.push(artifact(adapterRequestFile, "adapter_request", 1, agent));

  const createdAt = nowIso();
  // agents.* は各 adapter の所有領域なので、初期 state では空にしておく。
  const state = {
    schema_version: 1,
    review_session_id: reviewSessionId,
    created_at: createdAt,
    updated_at: createdAt,
    status: "active",
    target_root: targetRoot,
    current_round: 1,
    options,
    context: {
      context_file: contextFile,
      initial_prompt_file: promptFile,
      focus_question: focusQuestion,
      target_files: targetFiles,
      source,
    },
    agents: {},
    rounds: [
      {
        round: 1,
        kind: "initial_review",
        agent,
        prompt_file: promptFile,
        started_at: createdAt,
        completed_at: null,
        agent_result: null,
      },
    ],
    artifacts: {
      files: artifacts,
    },
    errors: [],
  };

  await writeJsonAtomic(paths.stateFile, state);

  return {
    review_session_id: reviewSessionId,
    state_file: paths.stateFile,
    artifact_dir: paths.artifactDir,
    context_file: contextFile,
    prompt_file: promptFile,
    adapter_request_file: adapterRequestFile,
    adapter_request: adapterRequest,
  };
}

// adapter response を既存 state の rounds[].agent_result に反映し、round を完了させる。
export async function completeRound({ state_file: stateFile, response_file: responseFile, response }) {
  // adapter は artifacts/errors を自分で append する。ここでは round 結果だけを閉じる。
  if (!stateFile) throw new Error("state_file is required.");
  const state = await readJson(stateFile);
  const agentResponse = response ?? (responseFile ? await readJson(responseFile) : null);
  if (!agentResponse) throw new Error("response or response_file is required.");

  const round = state.rounds?.find((entry) => entry.round === agentResponse.round && entry.agent === agentResponse.agent);
  if (!round) throw new Error(`round not found: ${agentResponse.round}/${agentResponse.agent}`);

  round.completed_at = nowIso();
  round.agent_result = {
    agent: agentResponse.agent,
    round: agentResponse.round,
    status: agentResponse.status,
    output_file: agentResponse.output_file,
    error: agentResponse.error,
  };

  state.updated_at = nowIso();

  await writeJsonAtomic(stateFile, state);
  return {
    review_session_id: state.review_session_id,
    state_file: stateFile,
    round: agentResponse.round,
    agent: agentResponse.agent,
    status: agentResponse.status,
  };
}

// CLI 引数を、この runner が扱う command/input option に変換する。
function parseArgs(argv) {
  const args = { command: argv[0], inputFile: null };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input" || arg === "-i") {
      args.inputFile = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

// CLI の使い方テキストを返す。
function usage() {
  return `Usage:
  node scripts/cross-agent.mjs prepare-initial --input <input.json>
  node scripts/cross-agent.mjs complete-round --input <input.json>`;
}

// runner input を stdin から読み取る。
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// runner input をファイルまたは stdin から読み込み、JSON として返す。
async function readInput(inputFile) {
  const text = inputFile ? await readFile(inputFile, "utf8") : await readStdin();
  return JSON.parse(text);
}

// CLI entrypoint。command に応じて prepare-initial または complete-round を実行する。
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const input = await readInput(args.inputFile);
  const result =
    args.command === "prepare-initial"
      ? await prepareInitialSession(input)
      : args.command === "complete-round"
        ? await completeRound(input)
        : null;

  if (!result) throw new Error(`Unknown command: ${args.command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
