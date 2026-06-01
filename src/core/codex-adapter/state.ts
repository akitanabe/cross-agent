import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  isSafePathSegment,
  type AdapterResponseArtifact,
  type AdapterResponseEnvelope,
  type AdapterResponseError,
  type AdapterResponseStatus,
  type ReviewDepth,
} from "../shared/adapter-envelope.ts";
import { normalizePath } from "../shared/path-utils.ts";
import type {
  AdapterRequestInput,
  AdapterRequestWithDataDir,
  ArtifactPathSet,
  CodexAgentState,
  EffortDecision,
  RecoverableError,
  SessionDecision,
} from "./types.ts";

const OWNER = "codex-adapter";

// agent-review の抽象 review_depth を Codex CLI の reasoning effort に変換する。
export function effortForReviewDepth(reviewDepth: ReviewDepth | null | undefined): EffortDecision {
  if (reviewDepth === "low") return { effort: "medium", warning: null };
  if (reviewDepth === "medium") return { effort: "high", warning: null };
  if (reviewDepth === "high") return { effort: "xhigh", warning: null };
  return {
    effort: "high",
    warning: `Unknown review_depth "${reviewDepth ?? ""}". Falling back to high.`,
  };
}

// data directory から、この review session 用の artifact directory を導出する。
export function artifactDirFor(dataDir: string, reviewSessionId: string): string {
  // plugin root へ書かないように、artifact は state store の隣に置く。
  return resolve(dataDir, "artifacts", reviewSessionId);
}

// data directory から、session state file を導出する。
export function sessionStateFileFor(dataDir: string, reviewSessionId: string): string {
  return resolve(dataDir, "sessions", `${reviewSessionId}.json`);
}

// data directory から、Codex 用の個別 agent state file を導出する。
export function agentStateFileFor(dataDir: string, reviewSessionId: string, agentId = "codex"): string {
  return resolve(dataDir, "sessions", reviewSessionId, "agents", `${agentId}.json`);
}

// round 番号から Codex adapter が生成する artifact 群のパスを組み立てる。
export function artifactPaths(artifactDir: string, round: number | string, agentId = "codex"): ArtifactPathSet {
  return {
    agent_id: agentId,
    adapter: "codex",
    runFile: resolve(artifactDir, `round-${round}-${agentId}-run.json`),
    outputFile: resolve(artifactDir, `round-${round}-${agentId}-output.md`),
    eventLog: resolve(artifactDir, `round-${round}-${agentId}-events.jsonl`),
    exitFile: resolve(artifactDir, `round-${round}-${agentId}-exit.json`),
    diagnosticFile: resolve(artifactDir, `round-${round}-${agentId}-diagnostic.md`),
    responseFile: resolve(artifactDir, `round-${round}-${agentId}-response.json`),
  };
}

// Codex の JSONL event stream から、新規 session の thread_id を抽出する。
export function extractThreadIdFromJsonl(text: string): string | null {
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
export function shouldStartNewSession(
  agentState: Partial<CodexAgentState> | null | undefined,
  targetRoot: string,
): SessionDecision {
  // Codex session は初回 cwd に固定されるため、target_root 変更時は新しい thread が必要。
  if (!agentState?.thread_id) {
    return { startNew: true, reason: "missing_thread_id" };
  }
  if (agentState.target_root !== targetRoot) {
    return { startNew: true, reason: "target_root_changed" };
  }
  return { startNew: false, reason: "resume" };
}

// 指定パスが存在するかを boolean で返す。
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// JSON ファイルを読み込み、オブジェクトとして返す。
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

// JSON ファイルがあれば読み込み、なければ null を返す。
export async function readJsonIfExists<T = unknown>(filePath: string): Promise<T | null> {
  return (await pathExists(filePath)) ? await readJson(filePath) : null;
}

// JSON を一時ファイルへ書いてから rename し、対象ファイルを atomic に更新する。
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  // 書き込み途中で落ちても state file が半端に壊れないようにする。
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

// state や artifact に記録する現在時刻を ISO 文字列で返す。
export function nowIso(): string {
  return new Date().toISOString();
}

// state に append する artifact metadata を作る。
export function artifact(path: string, kind: string, round: number, agentId = "codex"): AdapterResponseArtifact {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent_id: agentId,
    adapter: "codex",
    created_at: nowIso(),
    temporary: false,
  };
}

// response envelope と state に記録する recoverable error を作る。
export function makeError(code: string, message: string, detailsFile: string | null = null): RecoverableError {
  return {
    code,
    message,
    recoverable: true,
    details_file: detailsFile,
  };
}

// agent-review へ返す adapter response envelope を作る。
// adapter 境界の契約として、path フィールドは forward slash に統一する。
// Windows の `\` をそのまま JSON に乗せると、後段の `JSON.parse` が `\U` 等で落ちる。
export function makeResponse(
  request: AdapterRequestWithDataDir | null | undefined,
  status: AdapterResponseStatus,
  outputFile: string | null,
  artifacts: AdapterResponseArtifact[],
  error: AdapterResponseError,
): AdapterResponseEnvelope {
  const normalizedArtifacts = (artifacts ?? []).map((entry) =>
    entry?.path ? { ...entry, path: normalizePath(entry.path) } : entry,
  );
  const normalizedError =
    error && error.details_file ? { ...error, details_file: normalizePath(error.details_file) } : error;
  return {
    contract_version: 2,
    review_session_id: request?.review_session_id ?? null,
    agent_id: request?.agent_id ?? null,
    adapter: "codex",
    round: request?.round ?? null,
    status,
    output_file: outputFile ? normalizePath(outputFile) : outputFile,
    artifacts: normalizedArtifacts,
    error: normalizedError,
  };
}

// 診断情報を Markdown ファイルとして保存する。
export async function writeDiagnostic(filePath: string, lines: Array<string | null | undefined>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.filter(Boolean).join("\n")}\n`, "utf8");
}

// request envelope と参照先ファイル/ディレクトリが実行可能な状態か検証する。
export async function validateRequest(request: AdapterRequestInput): Promise<RecoverableError | null> {
  // ここでは adapter 境界だけを検証する。レビュー判断の意味解釈は agent-review の責務。
  const required = [
    "contract_version",
    "review_session_id",
    "agent_id",
    "adapter",
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
  if (request.contract_version !== 2) {
    return makeError("invalid_request_envelope", "contract_version must be 2.");
  }
  if (request.adapter !== "codex") {
    return makeError("invalid_request_envelope", 'adapter must be "codex".');
  }
  // review_session_id / agent_id は artifact/state のパス要素になるため path traversal を防ぐ。
  if (!isSafePathSegment(request.review_session_id)) {
    return makeError("invalid_request_envelope", `invalid review_session_id: ${request.review_session_id}`);
  }
  if (!isSafePathSegment(request.agent_id)) {
    return makeError("invalid_request_envelope", `invalid agent_id: ${request.agent_id}`);
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
