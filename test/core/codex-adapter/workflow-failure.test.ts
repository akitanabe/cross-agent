// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentStateFileFor, artifactDirFor, artifactPaths } from "../../../src/core/codex-adapter/state.ts";
import { CodexPrepareFailedError, failComplete, failPrepare } from "../../../src/core/codex-adapter/workflow-failure.ts";
import { createRequestFixture } from "../../helpers/codex-adapter-fixtures.ts";

test("failPrepare writes failed response and diagnostic, then rejects", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-failure-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);

    let caught: CodexPrepareFailedError | null = null;
    await assert.rejects(
      async () => {
        await failPrepare({
          request: { ...request, data_dir: dataDir },
          agentState: null,
          paths,
          code: "prompt_file_missing",
          message: "prompt_file does not exist.",
        });
      },
      (error) => {
        caught = error as CodexPrepareFailedError;
        return error instanceof CodexPrepareFailedError;
      },
    );

    assert.equal(caught?.path, caught?.response.error.details_file.replace("diagnostic.md", "response.json"));
    assert.equal(caught?.response.status, "failed");
    assert.equal(caught?.response.error.code, "prompt_file_missing");
    assert.equal(caught?.response.artifacts[0].kind, "diagnostic");

    const diagnostic = await readFile(paths.diagnosticFile, "utf8");
    assert.match(diagnostic, /status: failed/);
    assert.match(diagnostic, /code: prompt_file_missing/);

    const savedResponse = JSON.parse(await readFile(paths.responseFile, "utf8"));
    assert.equal(savedResponse.error.code, "prompt_file_missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("failComplete updates existing agent state with recoverable error", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-failure-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    const agentState = {
      schema_version: 1,
      review_session_id: request.review_session_id,
      agent: "codex",
      status: "active",
      thread_id: "thread-abc",
      target_root: request.target_root,
      last_run_file: paths.runFile,
      last_output_file: null,
      last_event_log: null,
      last_exit_file: null,
      last_error: null,
      artifacts: [],
      errors: [],
    };

    const result = await failComplete({
      request: { ...request, data_dir: dataDir },
      agentState,
      paths,
      code: "codex_exec_failed",
      message: "codex exec failed.",
      exitCode: 2,
      extraDiagnostics: ["- mode: initial"],
    });

    assert.equal(result.response.status, "failed");
    assert.equal(result.response.error.details_file.includes("\\"), false);

    const savedState = JSON.parse(await readFile(agentStateFileFor(dataDir, request.review_session_id), "utf8"));
    assert.equal(savedState.status, "failed");
    assert.equal(savedState.thread_id, "thread-abc");
    assert.equal(savedState.last_error.code, "codex_exec_failed");
    assert.equal(savedState.artifacts[0].kind, "diagnostic");
    assert.equal(savedState.errors[0].code, "codex_exec_failed");

    const diagnostic = await readFile(paths.diagnosticFile, "utf8");
    assert.match(diagnostic, /exit_code: 2/);
    assert.match(diagnostic, /mode: initial/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
