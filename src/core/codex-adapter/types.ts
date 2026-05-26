import type {
  AdapterRequestEnvelope,
  AdapterResponseArtifact,
  AdapterResponseError,
} from "../shared/adapter-envelope.ts";

export type CodexEffort = "medium" | "high" | "xhigh";

export type EffortDecision = {
  effort: CodexEffort;
  warning: string | null;
};

export type ArtifactPathSet = {
  runFile: string;
  outputFile: string;
  eventLog: string;
  exitFile: string;
  diagnosticFile: string;
  responseFile: string;
};

export type SessionDecision = {
  startNew: boolean;
  reason: "missing_thread_id" | "target_root_changed" | "resume";
};

export type CodexAgentState = {
  schema_version?: number;
  review_session_id: string;
  agent: "codex";
  status: string;
  thread_id: string | null;
  target_root: string | null;
  last_run_file?: string | null;
  last_output_file: string | null;
  last_event_log: string | null;
  last_exit_file?: string | null;
  last_error: AdapterResponseError;
  artifacts: AdapterResponseArtifact[];
  errors: Array<Record<string, unknown>>;
  updated_at?: string;
};

export type CodexRunSpecMode = "initial" | "resume";

export type CodexRunSpec = {
  schema_version: 1;
  kind: "codex_exec";
  review_session_id: string;
  round: number;
  mode: CodexRunSpecMode;
  target_root: string;
  thread_id: string | null;
  prompt_file: string;
  output_file: string;
  event_log: string;
  exit_file: string;
  model_reasoning_effort: CodexEffort;
  skip_git_repo_check: true;
  decision_reason?: SessionDecision["reason"];
  previous_thread_id?: string | null;
  previous_target_root?: string | null;
  warning?: string | null;
};

export type CodexExitResult = {
  code: number;
};

export type CodexAdapterCommand = "prepare" | "complete";

export type CodexPrepareOptions = {
  dataDir?: string | null;
};

export type ParsedCodexAdapterArgs = {
  command: CodexAdapterCommand | null;
  requestFile: string | null;
  dataDir: string | null;
  runFile: string | null;
  help?: boolean;
};

export type RecoverableError = NonNullable<AdapterResponseError> & {
  code: string;
  message: string;
  recoverable: true;
  details_file: string | null;
};

export type AdapterRequestInput = AdapterRequestEnvelope & Record<string, unknown>;

export type AdapterRequestWithDataDir = AdapterRequestInput & {
  data_dir?: string | null;
};

export type SessionState = {
  review_session_id?: string;
  [key: string]: unknown;
};
