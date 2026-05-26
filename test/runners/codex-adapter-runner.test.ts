// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequestFixture } from "../helpers/codex-adapter-fixtures.ts";

const runnerPath = fileURLToPath(new URL("../../scripts/codex-adapter-runner.mjs", import.meta.url));

test("codex adapter CLI prepare writes run spec file path to stdout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [runnerPath, "prepare", "--data-dir", dataDir, "--request", requestFile],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const runFile = result.stdout.trim();
    assert.match(runFile, /round-1-codex-run\.json$/);
    const runSpec = JSON.parse(await readFile(runFile, "utf8"));
    assert.equal(runSpec.kind, "codex_exec");
    assert.equal(runSpec.mode, "initial");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("codex adapter CLI prepare writes response file path to stdout on recoverable failure", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    await rm(request.prompt_file);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [runnerPath, "prepare", "--data-dir", dataDir, "--request", requestFile],
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

test("codex adapter CLI complete writes response file path to stdout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const prepared = spawnSync(
      process.execPath,
      [runnerPath, "prepare", "--data-dir", dataDir, "--request", requestFile],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(prepared.status, 0, prepared.stderr);

    const runFile = prepared.stdout.trim();
    const runSpec = JSON.parse(await readFile(runFile, "utf8"));
    await writeFile(runSpec.output_file, "review body\n", "utf8");
    await writeFile(
      runSpec.event_log,
      `${JSON.stringify({ type: "thread.started", thread_id: "thread-abc" })}\n`,
      "utf8",
    );
    await writeFile(runSpec.exit_file, `${JSON.stringify({ code: 0 }, null, 2)}\n`, "utf8");

    const completed = spawnSync(process.execPath, [runnerPath, "complete", "--data-dir", dataDir, "--run", runFile], {
      encoding: "utf8",
      windowsHide: true,
    });

    assert.equal(completed.status, 0, completed.stderr);
    const responseFile = completed.stdout.trim();
    assert.match(responseFile, /round-1-codex-response\.json$/);
    const response = JSON.parse(await readFile(responseFile, "utf8"));
    assert.equal(response.status, "completed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
