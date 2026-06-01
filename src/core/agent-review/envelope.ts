import { normalizePath, normalizePathList } from "../shared/path-utils.ts";
import type { AdapterRequestEnvelope, AgentReviewOptions, RoundKind } from "./types.ts";

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
}: {
  reviewSessionId: string;
  agent: string;
  round: number;
  roundKind: RoundKind;
  targetRoot: string;
  promptFile: string;
  contextFile?: string | null;
  targetFiles?: string[];
  focusQuestion?: string | null;
  options: AgentReviewOptions;
}): AdapterRequestEnvelope {
  // adapter 境界は v1 envelope に固定し、agent 固有の解釈は adapter 側へ任せる。
  return {
    contract_version: 1,
    review_session_id: reviewSessionId,
    agent,
    round,
    round_kind: roundKind,
    target_root: normalizePath(targetRoot) as string,
    prompt_file: normalizePath(promptFile) as string,
    context_file: normalizePath(contextFile) as string | null,
    target_files: normalizePathList(targetFiles) as string[],
    focus_question: focusQuestion,
    options: {
      review_depth: options.review_depth,
      timeout_seconds: options.timeout_seconds ?? null,
    },
  };
}
