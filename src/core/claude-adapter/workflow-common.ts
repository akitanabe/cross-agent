import { normalizePath, normalizePathList } from "../shared/path-utils.ts";
import type { AdapterRequestInput, ArtifactPathSet } from "./types.ts";

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

export function inputPath(paths: ArtifactPathSet): string {
  return normalizePath(paths.inputFile) as string;
}

export function outputPath(paths: ArtifactPathSet): string {
  return normalizePath(paths.outputFile) as string;
}

export function toDisplayPath(filePath: string | null | undefined): string {
  return (normalizePath(filePath) as string | null | undefined) ?? "";
}
