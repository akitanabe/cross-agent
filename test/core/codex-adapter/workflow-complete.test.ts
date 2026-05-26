// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentStateFileFor, artifactDirFor, artifactPaths } from "../../../src/core/codex-adapter/state.ts";
import { completeCodexRun } from "../../../src/core/codex-adapter/workflow-complete.ts";
import { prepareCodexRun } from "../../../src/core/codex-adapter/workflow-prepare.ts";
import { createRequestFixture, writeCodexArtifacts } from "../../helpers/codex-adapter-fixtures.ts";

test("completeCodexRun persists thread mapping after a prepared initial run", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const prepared = await prepareCodexRun(request, { dataDir });
    const runSpec = JSON.parse(await readFile(prepared.path, "utf8"));
    await writeCodexArtifacts(runSpec);

    const completed = await completeCodexRun(prepared.path, { dataDir });

    assert.equal(completed.response.status, "completed");
    assert.match(completed.response.output_file, /round-1-codex-output\.md$/);

    const state = JSON.parse(await readFile(agentStateFileFor(dataDir, "session-1"), "utf8"));
    assert.equal(state.thread_id, "thread-abc");
    assert.equal(state.status, "active");
    assert.equal(state.last_error, null);
    assert.match(state.last_run_file, /round-1-codex-run\.json$/);
    assert.match(state.last_exit_file, /round-1-codex-exit\.json$/);

    const events = await readFile(artifactPaths(artifactDirFor(dataDir, "session-1"), 1).eventLog, "utf8");
    assert.match(events, /thread\.started/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeCodexRun response envelope path fields are forward-slash normalized", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const prepared = await prepareCodexRun(request, { dataDir });
    const runSpec = JSON.parse(await readFile(prepared.path, "utf8"));
    await writeCodexArtifacts(runSpec);

    const completed = await completeCodexRun(prepared.path, { dataDir });
    const response = completed.response;

    assert.equal(response.status, "completed");
    assert.ok(!response.output_file.includes("\\"), `output_file has backslash: ${response.output_file}`);
    for (const entry of response.artifacts) {
      assert.ok(!entry.path.includes("\\"), `artifact path has backslash: ${entry.path}`);
    }
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(response)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeCodexRun resumes an existing Codex session when target root matches", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const first = await createRequestFixture(temp, { round: 1 });
    const firstPrepared = await prepareCodexRun(first.request, { dataDir: first.dataDir });
    const firstRunSpec = JSON.parse(await readFile(firstPrepared.path, "utf8"));
    await writeCodexArtifacts(firstRunSpec);
    await completeCodexRun(firstPrepared.path, { dataDir: first.dataDir });

    const second = await createRequestFixture(temp, { round: 2, prompt: "follow up" });
    const secondPrepared = await prepareCodexRun(second.request, { dataDir: second.dataDir });
    const secondRunSpec = JSON.parse(await readFile(secondPrepared.path, "utf8"));
    assert.equal(secondRunSpec.mode, "resume");
    assert.equal(secondRunSpec.thread_id, "thread-abc");

    await writeCodexArtifacts(secondRunSpec);
    const completed = await completeCodexRun(secondPrepared.path, { dataDir: second.dataDir });

    assert.equal(completed.response.status, "completed");
    const output = await readFile(completed.response.output_file, "utf8");
    assert.match(output, /mode:resume/);
    assert.match(output, /thread:thread-abc/);

    const state = JSON.parse(await readFile(agentStateFileFor(second.dataDir, "session-1"), "utf8"));
    assert.equal(state.thread_id, "thread-abc");
    assert.equal(state.artifacts.filter((entry) => entry.kind === "agent_output").length, 2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeCodexRun returns recoverable failure when Codex exit code is non-zero", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const prepared = await prepareCodexRun(request, { dataDir });
    const runSpec = JSON.parse(await readFile(prepared.path, "utf8"));
    await writeCodexArtifacts(runSpec, { exitCode: 2 });

    const completed = await completeCodexRun(prepared.path, { dataDir });

    assert.equal(completed.response.status, "failed");
    assert.equal(completed.response.error.code, "codex_exec_failed");
    const diagnostic = await readFile(completed.response.error.details_file, "utf8");
    assert.match(diagnostic, /exit_code: 2/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeCodexRun returns recoverable failure when run spec is invalid", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir } = await createRequestFixture(temp);
    const runFile = join(dataDir, "artifacts", "session-1", "round-1-codex-run.json");
    await mkdir(join(dataDir, "artifacts", "session-1"), { recursive: true });
    await writeFile(runFile, `${JSON.stringify({ schema_version: 1, kind: "wrong", round: 1 }, null, 2)}\n`, "utf8");

    const completed = await completeCodexRun(runFile, { dataDir });

    assert.equal(completed.response.status, "failed");
    assert.equal(completed.response.error.code, "codex_run_spec_invalid");
    assert.match(completed.path, /round-1-codex-response\.json$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
