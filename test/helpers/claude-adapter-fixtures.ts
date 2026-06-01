// @ts-nocheck
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionStateFileFor } from "../../src/core/claude-adapter/state.ts";

export async function createClaudeRequestFixture(temp, { round = 1, prompt = "review this", agentId = "claude" } = {}) {
  const targetRoot = join(temp, "repo");
  const dataDir = join(temp, "data");
  const promptFile = join(temp, `prompt-${round}.md`);
  await mkdir(targetRoot, { recursive: true });
  await mkdir(join(dataDir, "sessions"), { recursive: true });
  await writeFile(promptFile, prompt, "utf8");
  await writeFile(
    sessionStateFileFor(dataDir, "session-1"),
    `${JSON.stringify(
      {
        review_session_id: "session-1",
        schema_version: 2,
        rounds: [
          {
            round,
            kind: round === 1 ? "initial_review" : "follow_up",
            started_at: "2026-01-01T00:00:00.000Z",
            completed_at: null,
            agents: [
              {
                agent_id: agentId,
                adapter: "claude",
                status: "pending",
                prompt_file: promptFile,
                adapter_request_file: join(dataDir, "artifacts", "session-1", `round-${round}-${agentId}-adapter-request.json`),
                response_file: join(dataDir, "artifacts", "session-1", `round-${round}-${agentId}-response.json`),
                started_at: "2026-01-01T00:00:00.000Z",
                completed_at: null,
                agent_result: null,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    dataDir,
    targetRoot,
    request: {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: agentId,
      adapter: "claude",
      round,
      round_kind: round === 1 ? "initial_review" : "follow_up",
      target_root: targetRoot,
      prompt_file: promptFile,
      context_file: null,
      target_files: [],
      focus_question: null,
      options: { review_depth: "medium", timeout_seconds: null },
    },
  };
}
