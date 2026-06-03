import { readJson, sessionPaths, validateSessionStateSchema } from "./state.ts";
import type { CommandOutput, OutputType, SessionPathSet, SessionState } from "./types.ts";

export function commandOutput<T>(outputType: OutputType, content: T): CommandOutput<T> {
  return { output_type: outputType, content };
}

export async function readSession(
  dataDir: string,
  reviewSessionId: string | null | undefined,
): Promise<{ paths: SessionPathSet; state: SessionState }> {
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const paths = sessionPaths(dataDir, reviewSessionId);
  const state = await readJson<SessionState>(paths.stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }
  validateSessionStateSchema(state);

  return { paths, state };
}
