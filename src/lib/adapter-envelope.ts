export type ReviewDepth = "low" | "medium" | "high" | string;
export type RoundKind = "initial_review" | "deep_dive" | "recovery" | "follow_up" | string;
export type AdapterResponseStatus = "completed" | "failed" | "skipped";

export type AdapterRequestEnvelopeV1 = {
  contract_version: 1;
  review_session_id: string;
  agent: string;
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

export type AdapterRequestEnvelope = AdapterRequestEnvelopeV1;

export type AdapterResponseArtifact = {
  path: string;
  kind: string;
  owner?: string;
  round?: number | null;
  agent?: string | null;
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

export type AdapterResponseEnvelopeV1 = {
  contract_version: 1;
  review_session_id: string;
  agent: string;
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
  agent: string;
  round: number;
  status: AdapterResponseStatus | string;
  output_file?: string | null;
  artifacts?: AdapterResponseArtifact[];
  error?: AdapterResponseError;
};
