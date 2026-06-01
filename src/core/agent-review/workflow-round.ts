import { readFile } from "node:fs/promises";

import { resolveDataDir, validateAgentId, validateRoundNumber } from "./state.ts";
import type { CommandOutput, GetRoundInput, RoundAgentState } from "./types.ts";
import { commandOutput, readSession } from "./workflow-common.ts";

export async function getRound(input: GetRoundInput): Promise<{
  review_session_id: string;
  round: number;
  agent_id: string;
  adapter: string;
  status: string;
  output_file: string | null;
  error: unknown;
}> {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const { state } = await readSession(dataDir, reviewSessionId);

  const rounds = state.rounds ?? [];
  if (input.round !== undefined) validateRoundNumber(input.round);
  if (input.agent_id) validateAgentId(input.agent_id);
  const selectedRound =
    input.round !== undefined
      ? rounds.find((entry) => entry.round === input.round)
      : rounds
          .slice()
          .reverse()
          .find((entry) => entry.agents.some((agent) => agent.agent_result?.output_file));

  if (!selectedRound) throw new Error("round not found.");
  let selectedAgent: RoundAgentState | undefined;
  if (input.agent_id) {
    selectedAgent = selectedRound.agents.find((agent) => agent.agent_id === input.agent_id);
    if (!selectedAgent) throw new Error(`agent_id not found in round ${selectedRound.round}: ${input.agent_id}`);
  } else {
    const agentsWithOutput = selectedRound.agents.filter((agent) => agent.agent_result?.output_file);
    if (agentsWithOutput.length !== 1) {
      throw new Error(`round output is ambiguous or missing: ${selectedRound.round}`);
    }
    selectedAgent = agentsWithOutput[0];
  }
  const result = selectedAgent.agent_result;
  if (!result) throw new Error(`round is not completed: ${selectedRound.round}/${selectedAgent.agent_id}`);
  return {
    review_session_id: state.review_session_id,
    round: selectedRound.round,
    agent_id: selectedAgent.agent_id,
    adapter: selectedAgent.adapter,
    status: result.status,
    output_file: result.output_file,
    error: result.error,
  };
}

export async function getRoundOutput(input: GetRoundInput): Promise<CommandOutput<string>> {
  const round = await getRound(input);
  if (!round.output_file) throw new Error(`round has no output_file: ${round.round}/${round.agent_id}`);
  return commandOutput("text", await readFile(round.output_file, "utf8"));
}
