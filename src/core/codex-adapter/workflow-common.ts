import { normalizePath, normalizePathList } from "../shared/path-utils.ts";
import type { AdapterRequestInput, ArtifactPathSet } from "./types.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRequest(request: AdapterRequestInput): AdapterRequestInput {
  return {
    ...request,
    target_root: normalizePath(request.target_root),
    prompt_file: normalizePath(request.prompt_file),
    context_file: normalizePath(request.context_file),
    target_files: normalizePathList(request.target_files),
  };
}

export function responsePath(paths: ArtifactPathSet): string {
  return normalizePath(paths.responseFile) as string;
}

export function runPath(paths: ArtifactPathSet): string {
  return normalizePath(paths.runFile) as string;
}
