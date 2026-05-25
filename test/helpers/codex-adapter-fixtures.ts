// @ts-nocheck
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionStateFileFor } from "../../src/core/codex-adapter/state.ts";

export function hasUsableBashLauncher() {
  const result = spawnSync("bash", ["-c", 'exec "$@"', "bash", "printf", "ok"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

export async function writeFakeCodex(temp) {
  const fakeCodex = join(temp, "fake-codex.mjs");
  await writeFile(
    fakeCodex,
    `import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
if (outputIndex === -1) {
  process.stderr.write("missing -o\\n");
  process.exit(2);
}

const outputFile = args[outputIndex + 1];
const mode = args[0] === "exec" && args[1] === "resume" ? "resume" : "initial";
const threadId = mode === "resume" ? args[outputIndex + 2] : "thread-abc";
const promptText = args[args.length - 1];
await writeFile(
  outputFile,
  \`mode:\${mode}\\nthread:\${threadId}\\nprompt:\${promptText}\\n\`,
  "utf8",
);

if (mode === "initial") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "thread.resumed", thread_id: threadId }) + "\\n");
}
`,
    "utf8",
  );
  return fakeCodex;
}

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
