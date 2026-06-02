import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  isSafePathSegment,
  isSafeRoundNumber,
  type AdapterResponseArtifact,
  type AdapterResponseEnvelope,
  type AdapterResponseError,
  type AdapterResponseStatus,
} from "../shared/adapter-envelope.ts";
import { normalizePath } from "../shared/path-utils.ts";
import type { AdapterRequestInput, AdapterRequestWithDataDir, ArtifactPathSet, RecoverableError } from "./types.ts";

const OWNER = "claude-adapter";

export function artifactDirFor(dataDir: string, reviewSessionId: string): string {
  return resolve(dataDir, "artifacts", reviewSessionId);
}

export function sessionStateFileFor(dataDir: string, reviewSessionId: string): string {
  return resolve(dataDir, "sessions", `${reviewSessionId}.json`);
}

export function agentStateDirFor(dataDir: string, reviewSessionId: string): string {
  return resolve(dataDir, "sessions", reviewSessionId, "agents");
}

export function agentStateFileFor(dataDir: string, reviewSessionId: string, agentId = "claude"): string {
  return resolve(agentStateDirFor(dataDir, reviewSessionId), `${agentId}.json`);
}

export function agentContextFileFor(dataDir: string, reviewSessionId: string, agentId = "claude"): string {
  return resolve(agentStateDirFor(dataDir, reviewSessionId), `${agentId}-context.md`);
}

export function artifactPaths(artifactDir: string, round: number | string, agentId = "claude"): ArtifactPathSet {
  return {
    agent_id: agentId,
    adapter: "claude",
    inputFile: resolve(artifactDir, `round-${round}-${agentId}-input.md`),
    outputFile: resolve(artifactDir, `round-${round}-${agentId}-output.md`),
    diagnosticFile: resolve(artifactDir, `round-${round}-${agentId}-diagnostic.md`),
    responseFile: resolve(artifactDir, `round-${round}-${agentId}-response.json`),
  };
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function readJsonIfExists<T = unknown>(filePath: string): Promise<T | null> {
  return (await pathExists(filePath)) ? await readJson<T>(filePath) : null;
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function artifact(path: string, kind: string, round: number, agentId = "claude"): AdapterResponseArtifact {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent_id: agentId,
    adapter: "claude",
    created_at: nowIso(),
    temporary: false,
  };
}

export function makeError(code: string, message: string, detailsFile: string | null = null): RecoverableError {
  return {
    code,
    message,
    recoverable: true,
    details_file: detailsFile,
  };
}

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
    adapter: "claude",
    round: request?.round ?? null,
    status,
    output_file: outputFile ? normalizePath(outputFile) : outputFile,
    artifacts: normalizedArtifacts,
    error: normalizedError,
  };
}

export async function writeDiagnostic(filePath: string, lines: Array<string | null | undefined>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.filter(Boolean).join("\n")}\n`, "utf8");
}

export async function validateRequest(request: AdapterRequestInput): Promise<RecoverableError | null> {
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
  if (request.contract_version !== 2) return makeError("invalid_request_envelope", "contract_version must be 2.");
  if (request.adapter !== "claude") return makeError("invalid_request_envelope", 'adapter must be "claude".');
  // review_session_id / agent_id は artifact/state のパス要素になるため path traversal を防ぐ。
  if (!isSafePathSegment(request.review_session_id)) {
    return makeError("invalid_request_envelope", `invalid review_session_id: ${request.review_session_id}`);
  }
  if (!isSafePathSegment(request.agent_id)) {
    return makeError("invalid_request_envelope", `invalid agent_id: ${request.agent_id}`);
  }
  // round も artifact filename のパス要素になるため、positive safe integer に限定する。
  if (!isSafeRoundNumber(request.round)) {
    return makeError("invalid_request_envelope", `invalid round: ${request.round}`);
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
