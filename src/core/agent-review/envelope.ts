import { normalizePath, normalizePathList } from "../shared/path-utils.ts";
import type { AdapterRequestEnvelope, AgentReviewOptions, RoundKind } from "./types.ts";

// adapter に渡す request envelope v1 を組み立てる。
export function buildAdapterRequest({
  reviewSessionId,
  agentId,
  adapter,
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
  agentId: string;
  adapter: string;
  round: number;
  roundKind: RoundKind;
  targetRoot: string;
  promptFile: string;
  contextFile?: string | null;
  targetFiles?: string[];
  focusQuestion?: string | null;
  options: AgentReviewOptions;
}): AdapterRequestEnvelope {
  // adapter 境界では execution identity と adapter 種別を分離する。
  return {
    contract_version: 2,
    review_session_id: reviewSessionId,
    agent_id: agentId,
    adapter,
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
