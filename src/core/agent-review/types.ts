export type {
  AdapterRequestEnvelope,
  AdapterRequestEnvelopeV2,
  AdapterResponseArtifact,
  AdapterResponseEnvelope,
  AdapterResponseEnvelopeV2,
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

export type AgentReviewOptions = {
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
  agent_id: string | null;
  adapter: string | null;
  created_at: string;
  temporary: boolean;
};

export type AgentResult = {
  agent_id: string;
  adapter: string;
  round: number;
  status: AdapterResponseStatus | string;
  output_file: string | null;
  error: unknown;
};

export type RoundAgentState = {
  agent_id: string;
  adapter: string;
  status: "pending" | AdapterResponseStatus | string;
  prompt_file: string;
  adapter_request_file: string;
  response_file: string;
  started_at: string;
  completed_at: string | null;
  agent_result: AgentResult | null;
};

export type RoundEntry = {
  round: number;
  kind: RoundKind;
  started_at: string;
  completed_at: string | null;
  agents: RoundAgentState[];
};

export type SessionState = {
  schema_version?: number;
  review_session_id: string;
  created_at?: string;
  updated_at: string;
  status: string;
  target_root: string;
  current_round: number;
  options: AgentReviewOptions;
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

export type PrepareRequestResult = {
  agent_id: string;
  adapter: string;
  request_file: string;
};

export type PrepareRoundOutput = {
  review_session_id: string;
  round: number;
  requests: PrepareRequestResult[];
};

export type PrepareRoundResult = CommandOutput<PrepareRoundOutput> & {
  requests: PrepareRequestResult[];
  envelopes: AdapterRequestEnvelope[];
};

export type AgentLaunchSpec = {
  agent_id: string;
  adapter: string;
};

export type StartSessionInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
  target_root?: string | null;
  options?: Partial<AgentReviewOptions>;
};

export type PrepareInitialRoundInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
  agent_id?: string | null;
  adapter?: string | null;
  agents?: AgentLaunchSpec[];
  focus_question?: string | null;
  context_text?: string | null;
  target_files?: string[];
  source?: string | null;
};

export type PrepareNextRoundInput = {
  data_dir?: string | null;
  review_session_id?: string | null;
  agent_id?: string | null;
  adapter?: string | null;
  agents?: AgentLaunchSpec[];
  round_kind?: RoundKind | null;
  prompt_text?: string | null;
  previous_round?: number;
  previous_agent_id?: string | null;
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
  agent_id?: string | null;
};
