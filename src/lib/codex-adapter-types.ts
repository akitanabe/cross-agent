import type {
  AdapterRequestEnvelope,
  AdapterResponseArtifact,
  AdapterResponseError,
} from "./adapter-envelope.ts";

export type CodexEffort = "medium" | "high" | "xhigh";

export type EffortDecision = {
  effort: CodexEffort;
  warning: string | null;
};

export type ArtifactPathSet = {
  outputFile: string;
  eventLog: string;
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
  last_output_file: string | null;
  last_event_log: string | null;
  last_error: AdapterResponseError;
  artifacts: AdapterResponseArtifact[];
  errors: Array<Record<string, unknown>>;
  updated_at?: string;
};

export type CodexRunOptions = {
  codexBin?: string;
  codexBinArgs?: string[];
  dataDir?: string | null;
  launcher?: string | null;
};

export type ParsedCodexAdapterArgs = {
  requestFile: string | null;
  codexBin: string;
  dataDir: string | null;
  launcher: string | null;
  help?: boolean;
};

export type RecoverableError = NonNullable<AdapterResponseError> & {
  code: string;
  message: string;
  recoverable: true;
  details_file: string | null;
};

export type LaunchTarget = {
  command: string;
  args: string[];
};

export type CodexCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
  args: string[];
};

export type AdapterRequestInput = AdapterRequestEnvelope & Record<string, unknown>;

export type AdapterRequestWithDataDir = AdapterRequestInput & {
  data_dir?: string | null;
};

export type SessionState = {
  review_session_id?: string;
  [key: string]: unknown;
};
