// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareCodexRun } from "../../../src/core/codex-adapter/workflow-prepare.ts";
import { createRequestFixture } from "../../helpers/codex-adapter-fixtures.ts";

test("prepareCodexRun returns failed envelope when dataDir is missing (no env var fallback)", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { request } = await createRequestFixture(temp);
    const result = await prepareCodexRun(request);
    assert.equal(result.kind, "response");
    assert.equal(result.response.status, "failed");
    assert.equal(result.response.error.code, "invalid_request_envelope");
    assert.match(result.response.error.message, /--data-dir is required/);
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

test("prepareCodexRun failure envelope normalizes error.details_file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    await rm(request.prompt_file);

    const result = await prepareCodexRun(request, { dataDir });

    assert.equal(result.kind, "response");
    assert.equal(result.response.status, "failed");
    assert.equal(result.response.error.code, "prompt_file_missing");
    assert.ok(
      !result.response.error.details_file.includes("\\"),
      `error.details_file has backslash: ${result.response.error.details_file}`,
    );
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(result.response)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareCodexRun returns failure when session state is missing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    await rm(join(dataDir, "sessions", "session-1.json"));
    await mkdir(join(dataDir, "sessions"), { recursive: true });

    const result = await prepareCodexRun(request, { dataDir });

    assert.equal(result.kind, "response");
    assert.equal(result.response.status, "failed");
    assert.equal(result.response.error.code, "state_file_missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
