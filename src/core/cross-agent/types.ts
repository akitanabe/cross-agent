export type {
  AdapterRequestEnvelope,
  AdapterRequestEnvelopeV1,
  AdapterResponseArtifact,
  AdapterResponseEnvelope,
  AdapterResponseEnvelopeV1,
  AdapterResponseError,
  AdapterResponseStatus,
  ReviewDepth,
  RoundKind,
} from "../shared/adapter-envelope.ts";

import type {
  AdapterRequestEnvelope,
  AdapterResponseStatus,
  ReviewDepth,
  RoundKind,
} from "../shared/adapter-envelope.ts";

export type OutputType = "text" | "json";

export type CrossAgentOptions = {
  auto_deep_dive: boolean;
  review_depth: ReviewDepth;
  keep_artifacts: boolean;
  timeout_seconds?: number | null;
};

export type ArtifactRecord = {
  path: string;
  kind: string;
  owner: string;
  round: number | null;
  agent: string | null;
  created_at: string;
  temporary: boolean;
};

export type AgentResult = {
  agent: string;
  round: number;
  status: AdapterResponseStatus | string;
  output_file: string | null;
  error: unknown;
};

export type RoundEntry = {
  round: number;
  kind: RoundKind;
  agent: string;
  prompt_file: string;
  started_at: string;
  completed_at: string | null;
  agent_result: AgentResult | null;
};

export type SessionState = {
  schema_version?: number;
  review_session_id: string;
  created_at?: string;
  updated_at: string;
  status: string;
  target_root: string;
  current_round: number;
  options: CrossAgentOptions;
  context?: {
    context_file: string | null;
    initial_prompt_file: string | null;
    focus_question: string | null;
    target_files: string[];
    source: string;
  };
  rounds: RoundEntry[];
  artifacts: {
    files: ArtifactRecord[];
  };
  errors?: unknown[];
};

export type SessionPathSet = {
  sessionsDir: string;
  sessionDir: string;
  artifactDir: string;
  stateFile: string;
};

export type AdapterRequest = AdapterRequestEnvelope;
export type AdapterResponse = import("../shared/adapter-envelope.ts").AdapterResponseEnvelope;

export type CommandOutput<T = unknown> = {
  output_type: OutputType;
  content: T;
};

export type PrepareRoundResult = CommandOutput<string> & {
  request_file: string;
  envelope: AdapterRequestEnvelope;
};

export type StartSessionInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
  target_root?: string | null;
  options?: Partial<CrossAgentOptions>;
};

export type PrepareInitialRoundInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
  agent?: string | null;
  focus_question?: string | null;
  context_text?: string | null;
  target_files?: string[];
  source?: string | null;
};

export type PrepareNextRoundInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
  agent?: string | null;
  round_kind?: RoundKind | null;
  prompt_text?: string | null;
  previous_round?: number;
  focus_question?: string | null;
  target_files?: string[];
};

export type CompleteRoundInput = {
  data_dir?: string | null;
  response_file?: string | null;
};

export type CompleteCurrentRoundInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
};

export type GetRoundInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
  round?: number;
};
