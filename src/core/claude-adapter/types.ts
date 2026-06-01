import type {
  AdapterRequestEnvelope,
  AdapterResponseArtifact,
  AdapterResponseEnvelope,
  AdapterResponseError,
} from "../shared/adapter-envelope.ts";

export type ArtifactPathSet = {
  agent_id: string;
  adapter: "claude";
  inputFile: string;
  outputFile: string;
  diagnosticFile: string;
  responseFile: string;
};

export type ClaudeAgentState = {
  schema_version?: number;
  review_session_id: string;
  agent_id: string;
  adapter: "claude";
  status: string;
  target_root: string | null;
  context_file: string | null;
  last_input_file: string | null;
  last_output_file: string | null;
  last_error: AdapterResponseError;
  artifacts: AdapterResponseArtifact[];
  errors: Array<Record<string, unknown>>;
  updated_at?: string;
};

export type ClaudePrepareOptions = {
  dataDir?: string | null;
};

export type ClaudePrepareResult = {
  kind: "input";
  path: string;
  output_file: string;
  status: "prepared";
};

export type ClaudeCompleteResult = {
  path: string;
  response: AdapterResponseEnvelope;
};

export type ClaudeAdapterCommand = "prepare" | "complete";

export type ParsedClaudeAdapterArgs = {
  command: ClaudeAdapterCommand | null;
  requestFile: string | null;
  dataDir: string | null;
  outputFile: string | null;
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
  schema_version?: number;
  rounds?: Array<{
    round?: number;
    kind?: string;
    agents?: Array<{
      agent_id?: string;
      adapter?: string;
      prompt_file?: string;
      agent_result?: {
        output_file?: string | null;
        status?: string;
      } | null;
    }>;
  }>;
  context?: {
    target_files?: string[];
  };
  [key: string]: unknown;
};
