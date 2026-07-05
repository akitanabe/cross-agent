// @ts-nocheck

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { createClaudeRequestFixture } from "../helpers/claude-adapter-fixtures.ts";

const runnerPath = fileURLToPath(new URL("../../plugin/scripts/claude-adapter-runner.mjs", import.meta.url));

test("claude adapter CLI prepare writes input file path to stdout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [runnerPath, "prepare", "--data-dir", dataDir, "--request", requestFile],
      { encoding: "utf8", windowsHide: true },
    );

    assert.equal(result.status, 0, result.stderr);
    const inputFile = result.stdout.trim();
    assert.match(inputFile, /round-1-claude-input\.md$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("claude adapter CLI prepare writes failed response and no stdout on recoverable failure", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);
    await rm(request.prompt_file);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [runnerPath, "prepare", "--data-dir", dataDir, "--request", requestFile],
      { encoding: "utf8", windowsHide: true },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ClaudePrepareFailedError/);
    const responseFile = join(dataDir, "artifacts", request.review_session_id, "round-1-claude-response.json");
    const response = JSON.parse(await readFile(responseFile, "utf8"));
    assert.equal(response.status, "failed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("claude adapter CLI complete writes response file path to stdout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const prepared = spawnSync(
      process.execPath,
      [runnerPath, "prepare", "--data-dir", dataDir, "--request", requestFile],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    const inputText = await readFile(prepared.stdout.trim(), "utf8");
    const outputFile = inputText.match(/Write the final review body to:\r?\n\r?\n(.+)/)?.[1].trim();
    assert.ok(outputFile);
    await writeFile(outputFile, "review body\n", "utf8");

    const completed = spawnSync(
      process.execPath,
      [runnerPath, "complete", "--data-dir", dataDir, "--request", requestFile, "--output-file", outputFile],
      { encoding: "utf8", windowsHide: true },
    );

    assert.equal(completed.status, 0, completed.stderr);
    const responseFile = completed.stdout.trim();
    assert.match(responseFile, /round-1-claude-response\.json$/);
    const response = JSON.parse(await readFile(responseFile, "utf8"));
    assert.equal(response.status, "completed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
