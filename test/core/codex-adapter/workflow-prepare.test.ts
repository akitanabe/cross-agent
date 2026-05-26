// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactDirFor, artifactPaths } from "../../../src/core/codex-adapter/state.ts";
import { CodexPrepareFailedError } from "../../../src/core/codex-adapter/workflow-failure.ts";
import { prepareCodexRun } from "../../../src/core/codex-adapter/workflow-prepare.ts";
import { createRequestFixture } from "../../helpers/codex-adapter-fixtures.ts";

test("prepareCodexRun rejects when dataDir is missing (no env var fallback)", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { request } = await createRequestFixture(temp);
    await assert.rejects(() => prepareCodexRun(request), /--data-dir is required/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareCodexRun writes initial run spec", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);

    const prepared = await prepareCodexRun(request, { dataDir });
    assert.equal(prepared.kind, "run");
    assert.match(prepared.path, /round-1-codex-run\.json$/);

    const runSpec = JSON.parse(await readFile(prepared.path, "utf8"));
    assert.equal(runSpec.mode, "initial");
    assert.equal(runSpec.thread_id, null);
    assert.equal(runSpec.model_reasoning_effort, "high");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareCodexRun writes failure envelope then rejects", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    await rm(request.prompt_file);

    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    let caught: CodexPrepareFailedError | null = null;
    await assert.rejects(
      async () => {
        await prepareCodexRun(request, { dataDir });
      },
      (error) => {
        caught = error as CodexPrepareFailedError;
        return error instanceof CodexPrepareFailedError;
      },
    );

    assert.equal(caught?.path, paths.responseFile.replaceAll("\\", "/"));
    assert.equal(caught?.response.status, "failed");
    assert.equal(caught?.response.error.code, "prompt_file_missing");
    assert.ok(
      !caught?.response.error.details_file.includes("\\"),
      `error.details_file has backslash: ${caught?.response.error.details_file}`,
    );
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(caught?.response)));

    const savedResponse = JSON.parse(await readFile(paths.responseFile, "utf8"));
    assert.equal(savedResponse.error.code, "prompt_file_missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareCodexRun writes failure envelope when session state is missing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    await rm(join(dataDir, "sessions", "session-1.json"));
    await mkdir(join(dataDir, "sessions"), { recursive: true });

    let caught: CodexPrepareFailedError | null = null;
    await assert.rejects(
      async () => {
        await prepareCodexRun(request, { dataDir });
      },
      (error) => {
        caught = error as CodexPrepareFailedError;
        return error instanceof CodexPrepareFailedError;
      },
    );

    assert.equal(caught?.response.status, "failed");
    assert.equal(caught?.response.error.code, "state_file_missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
