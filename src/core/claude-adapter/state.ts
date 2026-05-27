import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  AdapterResponseArtifact,
  AdapterResponseEnvelope,
  AdapterResponseError,
  AdapterResponseStatus,
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

export function agentStateFileFor(dataDir: string, reviewSessionId: string): string {
  return resolve(agentStateDirFor(dataDir, reviewSessionId), "claude.json");
}

export function agentContextFileFor(dataDir: string, reviewSessionId: string): string {
  return resolve(agentStateDirFor(dataDir, reviewSessionId), "claude-context.md");
}

export function artifactPaths(artifactDir: string, round: number | string): ArtifactPathSet {
  return {
    inputFile: resolve(artifactDir, `round-${round}-claude-input.md`),
    outputFile: resolve(artifactDir, `round-${round}-claude-output.md`),
    diagnosticFile: resolve(artifactDir, `round-${round}-claude-diagnostic.md`),
    responseFile: resolve(artifactDir, `round-${round}-claude-response.json`),
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

export function artifact(path: string, kind: string, round: number): AdapterResponseArtifact {
  return {
    path,
    kind,
    owner: OWNER,
    round,
    agent: "claude",
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
    contract_version: 1,
    review_session_id: request?.review_session_id ?? null,
    agent: "claude",
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
  if (request.contract_version !== 1) return makeError("invalid_request_envelope", "contract_version must be 1.");
  if (request.agent !== "claude") return makeError("invalid_request_envelope", 'agent must be "claude".');

  try {
    const rootStat = await stat(request.target_root);
    if (!rootStat.isDirectory()) return makeError("target_root_missing", "target_root is not a directory.");
  } catch {
    return makeError("target_root_missing", "target_root does not exist.");
  }

  if (!(await pathExists(request.prompt_file))) {
    return makeError("invalid_request_envelope", "prompt_file does not exist.");
  }
  return null;
}
