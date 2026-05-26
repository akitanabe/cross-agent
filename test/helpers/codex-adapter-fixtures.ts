// @ts-nocheck
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionStateFileFor } from "../../src/core/codex-adapter/state.ts";

export async function createRequestFixture(temp, { round = 1, prompt = "review this" } = {}) {
  const targetRoot = join(temp, "repo");
  const dataDir = join(temp, "data");
  const promptFile = join(temp, `prompt-${round}.md`);
  await mkdir(targetRoot, { recursive: true });
  await mkdir(join(dataDir, "sessions"), { recursive: true });
  await writeFile(promptFile, prompt, "utf8");
  await writeFile(
    sessionStateFileFor(dataDir, "session-1"),
    `${JSON.stringify({ review_session_id: "session-1" }, null, 2)}\n`,
    "utf8",
  );

  return {
    dataDir,
    targetRoot,
    request: {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
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

export async function writeCodexArtifacts(runSpec, { exitCode = 0, threadId = "thread-abc", output = null } = {}) {
  await writeFile(
    runSpec.output_file,
    output ?? `mode:${runSpec.mode}\nthread:${threadId}\nprompt_file:${runSpec.prompt_file}\n`,
    "utf8",
  );
  const event =
    runSpec.mode === "initial"
      ? { type: "thread.started", thread_id: threadId }
      : { type: "thread.resumed", thread_id: threadId };
  await writeFile(runSpec.event_log, `${JSON.stringify(event)}\n`, "utf8");
  await writeFile(runSpec.exit_file, `${JSON.stringify({ code: exitCode }, null, 2)}\n`, "utf8");
}
