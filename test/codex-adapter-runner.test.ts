// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionStateFileFor } from "../src/core/codex-adapter/state.ts";

const runnerPath = fileURLToPath(new URL("../scripts/codex-adapter-runner.mjs", import.meta.url));

async function createRequestFixture(temp, { round = 1, prompt = "review this" } = {}) {
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

test("codex adapter CLI reads request file and writes response file path to stdout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    await rm(request.prompt_file);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        runnerPath,
        "--data-dir",
        dataDir,
        "--request",
        requestFile,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    assert.equal(result.status, 1, result.stderr);
    const responseFile = result.stdout.trim();
    assert.match(responseFile, /round-1-codex-response\.json$/);
    const response = JSON.parse(await readFile(responseFile, "utf8"));
    assert.equal(response.status, "failed");
    assert.equal(response.error.code, "prompt_file_missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
