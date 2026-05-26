import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ADAPTER_RESPONSE_STATUSES,
  SUPPORTED_CONTRACT_VERSION,
  isPathInside,
  nowIso,
  readJson,
  resolveDataDir,
  sessionPaths,
  validateRoundNumber,
  writeJsonAtomic,
} from "./state.ts";
import type {
  AdapterResponseEnvelope,
  AdapterResponseStatus,
  CompleteCurrentRoundInput,
  CompleteRoundInput,
  SessionPathSet,
  SessionState,
} from "./types.ts";
import { normalizePath } from "../shared/path-utils.ts";
import { readSession } from "./workflow-common.ts";

async function validateExistingFile(filePath: string, label: string): Promise<void> {
  let entry;
  try {
    entry = await stat(filePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`invalid adapter response: ${label} does not exist: ${filePath}`);
    }
    throw error;
  }
  if (!entry.isFile()) {
    throw new Error(`invalid adapter response: ${label} is not a file: ${filePath}`);
  }
}

export async function validateAdapterResponse(
  response: AdapterResponseEnvelope,
  paths: SessionPathSet,
  responseFile: string | null = null,
): Promise<void> {
  if (response.contract_version !== SUPPORTED_CONTRACT_VERSION) {
    throw new Error(`invalid adapter response: unsupported contract_version ${response.contract_version}`);
  }
  if (!ADAPTER_RESPONSE_STATUSES.has(response.status as AdapterResponseStatus)) {
    throw new Error(`invalid adapter response: unknown status ${response.status}`);
  }
  validateRoundNumber(response.round);

  if (responseFile) {
    if (!isPathInside(paths.artifactDir, responseFile)) {
      throw new Error(`invalid adapter response: response_file is outside artifact dir: ${responseFile}`);
    }
    await validateExistingFile(responseFile, "response_file");
  }

  if (response.status === "completed") {
    if (typeof response.output_file !== "string" || response.output_file.length === 0) {
      throw new Error("invalid adapter response: completed requires output_file");
    }
    if (!isPathInside(paths.artifactDir, response.output_file)) {
      throw new Error(`invalid adapter response: output_file is outside artifact dir: ${response.output_file}`);
    }
    await validateExistingFile(response.output_file, "output_file");
  } else if (response.output_file != null) {
    throw new Error(`invalid adapter response: ${response.status} must not include output_file`);
  }
}

async function resolveAdapterResponseInput(
  input: CompleteRoundInput,
  dataDir: string,
): Promise<{ response: AdapterResponseEnvelope; responseFile: string }> {
  if (!input.response_file) throw new Error("response_file is required.");
  const responseFile = normalizePath(input.response_file) as string;
  const artifactRoot = resolve(dataDir, "artifacts");
  if (!isPathInside(artifactRoot, responseFile)) {
    throw new Error(`invalid adapter response: response_file is outside artifact root: ${responseFile}`);
  }
  const response = await readJson<AdapterResponseEnvelope>(responseFile);
  return { response, responseFile };
}

async function completeResolvedRound({
  dataDir,
  agentResponse,
  responseFile,
  expected,
}: {
  dataDir: string;
  agentResponse: AdapterResponseEnvelope;
  responseFile: string;
  expected?: { reviewSessionId: string; round: number; agent: string };
}): Promise<Record<string, unknown>> {
  const reviewSessionId = agentResponse.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  if (expected) {
    if (reviewSessionId !== expected.reviewSessionId) {
      throw new Error("adapter response review_session_id does not match current round.");
    }
    if (agentResponse.round !== expected.round || agentResponse.agent !== expected.agent) {
      throw new Error(`adapter response does not match current round: ${expected.round}/${expected.agent}`);
    }
  }

  const paths = sessionPaths(dataDir, reviewSessionId);
  await validateAdapterResponse(agentResponse, paths, responseFile);

  const state = await readJson<SessionState>(paths.stateFile);
  if (state.review_session_id !== reviewSessionId) {
    throw new Error("state review_session_id does not match input review_session_id.");
  }

  const round = state.rounds?.find(
    (entry) => entry.round === agentResponse.round && entry.agent === agentResponse.agent,
  );
  if (!round) throw new Error(`round not found: ${agentResponse.round}/${agentResponse.agent}`);

  round.completed_at = nowIso();
  round.agent_result = {
    agent: agentResponse.agent,
    round: agentResponse.round as number,
    status: agentResponse.status,
    output_file: normalizePath(agentResponse.output_file ?? null) as string | null,
    error: agentResponse.error,
  };

  state.updated_at = nowIso();

  await writeJsonAtomic(paths.stateFile, state);
  return {
    review_session_id: state.review_session_id,
    state_file: paths.stateFile,
    round: agentResponse.round as number,
    agent: agentResponse.agent,
    status: agentResponse.status,
    response_file: responseFile,
  };
}

export async function completeRound(input: CompleteRoundInput): Promise<Record<string, unknown>> {
  const dataDir = resolveDataDir(input.data_dir);
  const { response: agentResponse, responseFile } = await resolveAdapterResponseInput(input, dataDir);
  return completeResolvedRound({ dataDir, agentResponse, responseFile });
}

export async function completeCurrentRound(input: CompleteCurrentRoundInput): Promise<Record<string, unknown>> {
  const dataDir = resolveDataDir(input.data_dir);
  const reviewSessionId = input.review_session_id;
  if (!reviewSessionId) throw new Error("review_session_id is required.");

  const { paths, state } = await readSession(dataDir, reviewSessionId);
  validateRoundNumber(state.current_round);
  const currentRounds = (state.rounds ?? []).filter((entry) => entry.round === state.current_round);
  if (currentRounds.length !== 1) {
    throw new Error(`current round is ambiguous or missing: ${state.current_round}`);
  }

  const currentRound = currentRounds[0];
  const responseFile = normalizePath(
    resolve(paths.artifactDir, `round-${currentRound.round}-${currentRound.agent}-response.json`),
  ) as string;
  if (!isPathInside(paths.artifactDir, responseFile)) {
    throw new Error(`invalid adapter response: derived response_file is outside artifact dir: ${responseFile}`);
  }
  const agentResponse = await readJson<AdapterResponseEnvelope>(responseFile);
  return completeResolvedRound({
    dataDir,
    agentResponse,
    responseFile,
    expected: {
      reviewSessionId,
      round: currentRound.round,
      agent: currentRound.agent,
    },
  });
}
