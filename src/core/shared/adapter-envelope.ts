export type ReviewDepth = "low" | "medium" | "high" | string;
export type RoundKind = "initial_review" | "deep_dive" | "recovery" | "follow_up" | string;
export type AdapterResponseStatus = "completed" | "failed" | "skipped";

export const SUPPORTED_ADAPTER_CONTRACT_VERSION = 2;

// review_session_id / agent_id は state/artifact のパス要素になる。`..` や slash で
// data dir 外に出られないよう、ASCII 英数 + `.` `_` `-` のみを安全な path segment とみなす。
// orchestrator (agent-review) 側でも検証するが、adapter 単体起動でも path traversal を
// 防げるよう adapter 境界でも再検証する。
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && SAFE_PATH_SEGMENT_RE.test(value) && !value.includes("..");
}

export type AdapterRequestEnvelopeV2 = {
  contract_version: 2;
  review_session_id: string;
  agent_id: string;
  adapter: string;
  round: number;
  round_kind: RoundKind;
  target_root: string;
  prompt_file: string;
  context_file: string | null;
  target_files: string[];
  focus_question: string | null;
  options: {
    review_depth: ReviewDepth;
    timeout_seconds: number | null;
  };
};

export type AdapterRequestEnvelope = AdapterRequestEnvelopeV2;

export type AdapterResponseArtifact = {
  path: string;
  kind: string;
  owner?: string;
  round?: number | null;
  agent_id?: string | null;
  adapter?: string | null;
  created_at?: string;
  temporary?: boolean;
  [key: string]: unknown;
};

export type AdapterResponseError = {
  code?: string;
  message?: string;
  recoverable?: boolean;
  details_file?: string | null;
  [key: string]: unknown;
} | null;

export type AdapterResponseEnvelopeV2 = {
  contract_version: 2;
  review_session_id: string;
  agent_id: string;
  adapter: string;
  round: number;
  status: AdapterResponseStatus;
  output_file: string | null;
  artifacts: AdapterResponseArtifact[];
  error: AdapterResponseError;
};

// Adapter response は外部プロセスから読むため、検証前は version/status/optional fields を緩く扱う。
export type AdapterResponseEnvelope = {
  contract_version: number;
  review_session_id: string | null;
  agent_id?: string | null;
  adapter?: string | null;
  round: number | null;
  status: AdapterResponseStatus | string;
  output_file?: string | null;
  artifacts?: AdapterResponseArtifact[];
  error?: AdapterResponseError;
};
