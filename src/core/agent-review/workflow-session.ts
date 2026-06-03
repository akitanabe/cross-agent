import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { normalizePath } from "../shared/path-utils.ts";
import {
  ensureDirectory,
  normalizeOptions,
  nowIso,
  resolveDataDir,
  SUPPORTED_SESSION_SCHEMA_VERSION,
  sessionPaths,
  writeJsonAtomic,
} from "./state.ts";
import type { CommandOutput, StartSessionInput } from "./types.ts";
import { commandOutput } from "./workflow-common.ts";

export async function startSession(input: StartSessionInput): Promise<CommandOutput<string>> {
  const dataDir = resolveDataDir(input.data_dir);
  const targetRoot = normalizePath(input.target_root) as string | null;
  if (!targetRoot) throw new Error("target_root is required.");
  await ensureDirectory(targetRoot, "target_root");

  const reviewSessionId = input.review_session_id ?? randomUUID();
  const paths = sessionPaths(dataDir, reviewSessionId);
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.artifactDir, { recursive: true });

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
