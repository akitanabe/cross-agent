#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePath, normalizePathList } from "./path-utils.mjs";

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

// input または環境変数から plugin data directory を解決する。
function resolveDataDir(inputDataDir) {
  // data_dir は JSON 本文での必須フィールド。plugin 文脈では SKILL.md の例の通り
  // ${CLAUDE_PLUGIN_DATA} を埋め込む (skill content 内で Claude Code が絶対パスに展開する)。
  // Bash tool に env var として export されないことが公式仕様なので、env var フォールバックは
  // 直接 CLI から呼ぶケース以外では発火しないデッドコードになる。利用源を一本化する。
  if (!inputDataDir) {
    throw new Error(
      "data_dir is required. In plugin context, embed `\"data_dir\": \"${CLAUDE_PLUGIN_DATA}\"` " +
        "in the JSON body (Claude Code substitutes this in skill content).",
    );
  }
  return normalizePath(inputDataDir);
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
  const sessionDir = resolve(sessionsDir, reviewSessionId);
  const artifactDir = resolve(dataDir, "artifacts", reviewSessionId);
  return {
    sessionsDir,
    sessionDir,
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

// 追加 round 用の prompt 本文を組み立てる。
export function buildNextRoundPrompt({ promptText, previousOutputFile = null, focusQuestion = null }) {
  if (!promptText) throw new Error("prompt_text is required.");

  const sections = [
    "あなたは同じレビューセッションを継続しています。以下の追加依頼にだけ答えてください。",
  ];

  if (previousOutputFile) {
    sections.push(`## 前回 round の出力\n${previousOutputFile}`);
  }

  if (focusQuestion) {
    sections.push(`## フォーカス質問\n${focusQuestion}`);
  }

  sections.push(`## 追加依頼\n${promptText}`);

  sections.push(`## 出力方針
- 前回 round の単なる繰り返しは避ける
- 新しく確信度が上がった点、下がった点を明示する
- 採用すべき対応、保留すべき対応、追加調査が必要な点を分ける`);

  return `${sections.join("\n\n")}\n`;
}

// adapter に渡す request envelope v1 を組み立てる。
export function buildAdapterRequest({
  reviewSessionId,
  agent,
  round,
  roundKind,
  targetRoot,
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

// review_session_id から session state を読み込む。
async function readSession(dataDir, reviewSessionId) {
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const paths = sessionPaths(dataDir, reviewSessionId);
  const state = await readJson(paths.stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

  return { paths, state };
}

// round の prompt、adapter request、state entry をまとめて作成する。
async function prepareRound({
  paths,
  state,
  reviewSessionId,
  agent,
  round,
  roundKind,
  promptText,
  contextFile,
  targetFiles,
  focusQuestion,
  resetRounds = false,
  extraArtifacts = [],
  updateState = null,
}) {
  const promptFile = resolve(paths.artifactDir, `round-${round}-prompt.md`);
  await writeFile(promptFile, promptText, "utf8");

  const adapterRequest = buildAdapterRequest({
    reviewSessionId,
    agent,
    round,
    roundKind,
    targetRoot: state.target_root,
    promptFile,
    contextFile,
    targetFiles,
    focusQuestion,
    options: state.options,
  });

  const adapterRequestFile = resolve(paths.artifactDir, `round-${round}-adapter-request.json`);
  await writeJsonAtomic(adapterRequestFile, adapterRequest);

  const now = nowIso();
  state.updated_at = now;
  state.current_round = round;
  updateState?.({ promptFile, now });

  const roundEntry = {
    round,
    kind: roundKind,
    agent,
    prompt_file: promptFile,
    started_at: now,
    completed_at: null,
    agent_result: null,
  };
  if (resetRounds) {
    state.rounds = [roundEntry];
  } else {
    state.rounds ??= [];
    state.rounds.push(roundEntry);
  }

  state.artifacts ??= { files: [] };
  state.artifacts.files ??= [];
  state.artifacts.files.push(
    ...extraArtifacts,
    artifact(promptFile, "prompt", round, agent),
    artifact(adapterRequestFile, "adapter_request", round, agent),
  );

  await writeJsonAtomic(paths.stateFile, state);

  return commandOutput("json", adapterRequest);
}

// review session の空 state を作成する。
export async function startSession(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const targetRoot = normalizePath(input.target_root);
  if (!targetRoot) throw new Error("target_root is required.");
  await ensureDirectory(targetRoot, "target_root");

  const reviewSessionId = input.review_session_id ?? randomUUID();
  const paths = sessionPaths(dataDir, reviewSessionId);
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.artifactDir, { recursive: true });

  const options = normalizeOptions(input.options);
  const createdAt = nowIso();
  const state = {
    schema_version: 1,
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
      source: "files",
    },
    rounds: [],
    artifacts: {
      files: [],
    },
    errors: [],
  };

  await writeJsonAtomic(paths.stateFile, state);

  return commandOutput("text", reviewSessionId);
}

// 初回 round に必要な artifact、prompt、adapter request を作成する。
export async function prepareInitialRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  const { paths, state } = await readSession(dataDir, reviewSessionId);

  const agent = input.agent ?? "codex";
  const targetFiles = normalizePathList(input.target_files ?? []);
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

  const promptText = buildInitialPrompt({ focusQuestion, contextFile, targetFiles });
  return prepareRound({
    paths,
    state,
    reviewSessionId,
    agent,
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
        source,
      };
    },
  });
}

// 追加 round に必要な prompt と adapter request を作成する。
export async function prepareNextRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  const { paths, state } = await readSession(dataDir, reviewSessionId);
  if (state.status !== "active") {
    throw new Error(`session is not active: ${state.status}`);
  }

  const rounds = state.rounds ?? [];
  const previousRound =
    input.previous_round !== undefined
      ? rounds.find((entry) => entry.round === input.previous_round)
      : rounds.slice().reverse()[0];
  if (!previousRound) throw new Error("previous round not found.");
  if (!previousRound.agent_result) {
    throw new Error(`previous round is not completed: ${previousRound.round}/${previousRound.agent}`);
  }

  const previousResult = previousRound.agent_result;
  const agent = input.agent ?? previousRound.agent;
  const roundKind = input.round_kind ?? "follow_up";
  const focusQuestion = input.focus_question ?? state.context?.focus_question ?? null;
  const targetFiles = normalizePathList(input.target_files ?? state.context?.target_files ?? []);
  const contextFile = state.context?.context_file ?? null;
  const nextRound = Math.max(0, ...rounds.map((entry) => entry.round)) + 1;

  const maxRounds = state.options?.max_rounds ?? DEFAULT_OPTIONS.max_rounds;
  if (nextRound > maxRounds && roundKind !== "follow_up") {
    throw new Error(`max_rounds exceeded: ${nextRound} > ${maxRounds}`);
  }

  const promptText = buildNextRoundPrompt({
    promptText: input.prompt_text,
    previousOutputFile: previousResult.output_file ?? null,
    focusQuestion,
  });
  return prepareRound({
    paths,
    state,
    reviewSessionId,
    agent,
    round: nextRound,
    roundKind,
    promptText,
    contextFile,
    targetFiles,
    focusQuestion,
  });
}

// adapter response を既存 state の rounds[].agent_result に反映し、round を完了させる。
export async function completeRound(input) {
  // adapter は artifacts/errors を自分で append する。ここでは round 結果だけを閉じる。
  const dataDir = resolveDataDir(input.data_dir);
  const agentResponse = input;
  const reviewSessionId = agentResponse.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const stateFile = sessionPaths(dataDir, reviewSessionId).stateFile;

  const state = await readJson(stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

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

// state から対象 round の結果を取得する。
export async function getRound(input) {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const stateFile = sessionPaths(dataDir, reviewSessionId).stateFile;
  const state = await readJson(stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

  const rounds = state.rounds ?? [];
  const round =
    input.round !== undefined
      ? rounds.find((entry) => entry.round === input.round)
      : rounds
          .slice()
          .reverse()
          .find((entry) => entry.agent_result?.output_file);

  if (!round) throw new Error("round not found.");
  const result = round.agent_result;
  if (!result) throw new Error(`round is not completed: ${round.round}/${round.agent}`);
  return {
    review_session_id: state.review_session_id,
    round: round.round,
    agent: round.agent,
    status: result.status,
    output_file: result.output_file,
    error: result.error,
  };
}

// round の output file を読み、CLI が stdout へ出す text output を作る。
export async function getRoundOutput(input) {
  const round = await getRound(input);
  if (!round.output_file) throw new Error(`round has no output_file: ${round.round}/${round.agent}`);
  return commandOutput("text", await readFile(round.output_file, "utf8"));
}

// CLI 引数を、この runner が扱う command/input option に変換する。
function parseArgs(argv) {
  const args = { command: argv[0], inputFile: null, positional: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input" || arg === "-i") {
      args.inputFile = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

// CLI の使い方テキストを返す。
function usage() {
  return `Usage:
  node scripts/cross-agent-runner.mjs normalize-path <path>
  node scripts/cross-agent-runner.mjs start-session --input <input.json>
  node scripts/cross-agent-runner.mjs prepare-initial --input <input.json>
  node scripts/cross-agent-runner.mjs prepare-next-round --input <input.json>
  node scripts/cross-agent-runner.mjs complete-round --input <input.json>
  node scripts/cross-agent-runner.mjs get-round-output --input <input.json>`;
}

// command result を stdout へ出す形式へそろえる。
function commandOutput(outputType, content) {
  return { output_type: outputType, content };
}

function writeCommandOutput(result) {
  if (result.output_type === "text") {
    const text = String(result.content ?? "");
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.content, null, 2)}\n`);
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

  // normalize-path はパスを argv で受け、正規化結果を stdout へ返す独立コマンド。
  // パスを JSON に埋めると \U などで JSON.parse が落ちるため、呼び出し側はこれで先に
  // 正規化してから他コマンドの JSON 本文に埋める。stdin/JSON 入力は不要。
  if (args.command === "normalize-path") {
    // 引数が 2 個以上なら quote 忘れの可能性が高い (例: `normalize-path C:\Program Files\...` が
    // 空白で分解されている)。サイレントに先頭だけ採用するとパス断片だけ正規化して返してしまい
    // 事故るので、ここで fail-loud にする。
    if (args.positional.length === 0) throw new Error("normalize-path requires a path argument.");
    if (args.positional.length > 1) {
      throw new Error(
        `normalize-path expects exactly one path; received ${args.positional.length}. ` +
          `Quote the path if it contains spaces.`,
      );
    }
    process.stdout.write(`${normalizePath(args.positional[0])}\n`);
    return;
  }

  const input = await readInput(args.inputFile);
  let result = null;
  if (args.command === "start-session") {
    result = await startSession(input);
  } else if (args.command === "prepare-initial") {
    result = await prepareInitialRound(input);
  } else if (args.command === "prepare-next-round") {
    result = await prepareNextRound(input);
  } else if (args.command === "complete-round") {
    result = commandOutput("json", await completeRound(input));
  } else if (args.command === "get-round-output") {
    result = await getRoundOutput(input);
  }

  if (!result) throw new Error(`Unknown command: ${args.command}`);
  writeCommandOutput(result);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
