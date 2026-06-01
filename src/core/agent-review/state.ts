import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { normalizePath } from "../shared/path-utils.ts";
import type { AdapterResponseStatus, ArtifactRecord, AgentReviewOptions, SessionPathSet } from "./types.ts";

const OWNER = "agent-review";

export const DEFAULT_OPTIONS: AgentReviewOptions = {
  auto_deep_dive: true,
  review_depth: "medium",
  keep_artifacts: false,
};

export const SUPPORTED_CONTRACT_VERSION = 1;
export const ADAPTER_RESPONSE_STATUSES = new Set<AdapterResponseStatus>(["completed", "failed", "skipped"]);

// review_session_id は state/artifact のパス要素になる。`..` や slash で data dir 外に
// 出られないよう、ASCII の英数 + `.` `_` `-` のみ許可する。UUID はこの集合に含まれる。
const REVIEW_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

// review_session_id が path traversal に使えない安全な文字列であることを検証する。
export function validateReviewSessionId(reviewSessionId: unknown): asserts reviewSessionId is string {
  if (typeof reviewSessionId !== "string" || reviewSessionId.length === 0) {
    throw new Error("review_session_id must be a non-empty string.");
  }
  if (!REVIEW_SESSION_ID_RE.test(reviewSessionId) || reviewSessionId.includes("..")) {
    throw new Error(`invalid review_session_id: ${reviewSessionId}`);
  }
}

// round 番号が positive safe integer であることを検証する。文字列や負数、小数で
// artifact filename が壊れたり、state lookup が暗黙に失敗するのを防ぐ。
export function validateRoundNumber(round: unknown): asserts round is number {
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) {
    throw new Error(`invalid round: ${round}`);
  }
}

// 親パス配下に子パスがあるかを判定する。drive 違いでも誤判定しない。
export function isPathInside(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  if (parentPath === childPath) return true;
  const rel = relative(parentPath, childPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// state や artifact に記録する現在時刻を ISO 文字列で返す。
export function nowIso(): string {
  return new Date().toISOString();
}

// JSON を一時ファイルへ書いてから rename し、対象ファイルを atomic に更新する。
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  // state 更新中に落ちても JSON が半端に壊れないようにする。
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

// JSON ファイルを読み込み、オブジェクトとして返す。
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

// input から plugin data directory を解決する。
export function resolveDataDir(inputDataDir: string | null | undefined): string {
  // data_dir は CLI から `--data-dir` argv で必須入力 (main 側で input.data_dir に注入する)。
  // 直接 JS API を叩く呼び出し (テストなど) では input.data_dir に同等の値を渡す。
  // plugin 文脈では SKILL.md の例の通り `${CLAUDE_PLUGIN_DATA}` を渡す
  // (Claude Code が skill content 内で絶対パスに展開する)。Bash tool に env var として export
  // されないことが公式仕様なので、env var フォールバックは持たない。
  if (!inputDataDir) {
    throw new Error(
      'data_dir is required. In plugin context, pass `--data-dir "${CLAUDE_PLUGIN_DATA}"` ' +
        "(Claude Code substitutes this in skill content).",
    );
  }
  return normalizePath(inputDataDir) as string;
}

// 指定パスが存在し、ディレクトリであることを検証する。
export async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
    throw error;
  }
}

// data directory と review_session_id から session/state/artifact のパスを組み立てる。
export function sessionPaths(dataDir: string, reviewSessionId: string): SessionPathSet {
  // すべての session/artifact パス組み立てがここを通るため、ID 検証もここに置く。
  validateReviewSessionId(reviewSessionId);
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

// state に append する agent-review 生成 artifact metadata を作る。
export function artifact(
  path: string,
  kind: string,
  round: number | null = null,
  agent: string | null = null,
): ArtifactRecord {
  // agent-review が作った artifact だけ owner=agent-review として記録する。
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

// 省略された agent-review option を既定値で補完する。
export function normalizeOptions(options: Partial<AgentReviewOptions> = {}): AgentReviewOptions {
  // Skill 側が省略した値を、state に残る安定した既定値へそろえる。
  return {
    ...DEFAULT_OPTIONS,
    ...options,
  };
}
