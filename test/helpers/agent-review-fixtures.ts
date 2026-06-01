// @ts-nocheck
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionPaths } from "../../src/core/agent-review/state.ts";
import { completeRound } from "../../src/core/agent-review/workflow-complete.ts";

export async function writeAdapterResponse(filePath, response) {
  await writeFile(filePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
}

export async function completeRoundFromEnvelope(dataDir, response) {
  const paths = sessionPaths(dataDir, response.review_session_id);
  const responseFile = join(paths.artifactDir, `round-${response.round}-${response.agent_id}-response.json`);
  await writeAdapterResponse(responseFile, response);
  return completeRound({ data_dir: dataDir, response_file: responseFile });
}
