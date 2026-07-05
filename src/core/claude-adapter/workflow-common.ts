import { normalizePath } from "../shared/path-utils.ts";
import type { AdapterRequestInput, ArtifactPathSet } from "./types.ts";

function normalizeEnvelopePath<T>(value: T): T | string {
  return typeof value === "string" && value.includes("\\") ? normalizePath(value, "win32") : normalizePath(value);
}

function normalizeEnvelopePathList<T>(values: T): T | string[] {
  if (!Array.isArray(values)) return values;
  return values.map((value) => normalizeEnvelopePath(value));
}

export function normalizeRequest(request: AdapterRequestInput): AdapterRequestInput {
  return {
    ...request,
    target_root: normalizeEnvelopePath(request.target_root),
    prompt_file: normalizeEnvelopePath(request.prompt_file),
    context_file: normalizeEnvelopePath(request.context_file),
    target_files: normalizeEnvelopePathList(request.target_files),
  };
}

export function responsePath(paths: ArtifactPathSet): string {
  return normalizeEnvelopePath(paths.responseFile) as string;
}

export function inputPath(paths: ArtifactPathSet): string {
  return normalizeEnvelopePath(paths.inputFile) as string;
}

export function outputPath(paths: ArtifactPathSet): string {
  return normalizeEnvelopePath(paths.outputFile) as string;
}

export function toDisplayPath(filePath: string | null | undefined): string {
  return (normalizeEnvelopePath(filePath) as string | null | undefined) ?? "";
}
