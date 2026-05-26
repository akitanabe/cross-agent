// @ts-nocheck
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionStateFileFor } from "../../src/core/claude-adapter/state.ts";

export async function createClaudeRequestFixture(temp, { round = 1, prompt = "review this" } = {}) {
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
        rounds: [
          {
            round,
            kind: round === 1 ? "initial_review" : "follow_up",
            agent: "claude",
            prompt_file: promptFile,
            agent_result: null,
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
      contract_version: 1,
      review_session_id: "session-1",
      agent: "claude",
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
