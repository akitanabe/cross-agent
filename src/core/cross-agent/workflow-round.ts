import { readFile } from "node:fs/promises";

import { readJson, resolveDataDir, sessionPaths, validateRoundNumber } from "./state.ts";
import type { CommandOutput, GetRoundInput, SessionState } from "./types.ts";
import { commandOutput } from "./workflow-common.ts";

export async function getRound(input: GetRoundInput): Promise<{
  review_session_id: string;
  round: number;
  agent: string;
  status: string;
  output_file: string | null;
  error: unknown;
}> {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const stateFile = sessionPaths(dataDir, reviewSessionId).stateFile;
  const state = await readJson<SessionState>(stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

  const rounds = state.rounds ?? [];
  if (input.round !== undefined) validateRoundNumber(input.round);
  const round =
    input.round !== undefined
      ? rounds.find((entry) => entry.round === input.round)
      : rounds
          .slice()
          .reverse()
          .find((entry) => entry.agent_result?.output_file);

  if (!round) throw new Error("round not found.");
  const result = round.agent_result;
  if (!result) throw new Error(`round is not completed: ${round.round}/${round.agent}`);
  return {
    review_session_id: state.review_session_id,
    round: round.round,
    agent: round.agent,
    status: result.status,
    output_file: result.output_file,
    error: result.error,
  };
}

export async function getRoundOutput(input: GetRoundInput): Promise<CommandOutput<string>> {
  const round = await getRound(input);
  if (!round.output_file) throw new Error(`round has no output_file: ${round.round}/${round.agent}`);
  return commandOutput("text", await readFile(round.output_file, "utf8"));
}
