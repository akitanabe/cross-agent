// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completedArtifacts,
  appendCompletionDiagnostic,
} from "../../../src/core/codex-adapter/completion-artifacts.ts";
import { resolveCompletedThreadId } from "../../../src/core/codex-adapter/complete-helpers.ts";
import { artifactDirFor, artifactPaths } from "../../../src/core/codex-adapter/state.ts";
import { makeCodexRunSpec } from "../../../src/core/codex-adapter/run-spec.ts";
import { createRequestFixture } from "../../helpers/codex-adapter-fixtures.ts";

function agentStateFor(request) {
  return {
    schema_version: 1,
    review_session_id: request.review_session_id,
    agent: "codex",
    status: "active",
    thread_id: "thread-abc",
    target_root: request.target_root,
    last_output_file: null,
    last_event_log: null,
    last_exit_file: null,
    last_error: null,
    artifacts: [],
    errors: [],
  };
}

test("completedArtifacts records run, output, event log, and exit status", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-complete-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    const runSpec = makeCodexRunSpec(request, paths, agentStateFor(request));

    const artifacts = completedArtifacts(runSpec, paths);

    assert.deepEqual(
      artifacts.map((entry) => entry.kind),
      ["run_spec", "agent_output", "event_log", "exit_status"],
    );
    assert.equal(
      artifacts.every((entry) => entry.owner === "codex-adapter"),
      true,
    );
    assert.equal(
      artifacts.every((entry) => entry.round === request.round),
      true,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("appendCompletionDiagnostic writes warning diagnostic only when needed", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-complete-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    request.options.review_depth = "surprise";
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    const runSpec = makeCodexRunSpec(request, paths, agentStateFor(request));
    const artifacts = completedArtifacts(runSpec, paths);

    await appendCompletionDiagnostic(runSpec, paths, "thread-abc", artifacts);

    assert.equal(artifacts.at(-1).kind, "diagnostic");
    const diagnostic = await readFile(paths.diagnosticFile, "utf8");
    assert.match(diagnostic, /status: completed/);
    assert.match(diagnostic, /thread_id: thread-abc/);
    assert.match(diagnostic, /Unknown review_depth/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveCompletedThreadId extracts initial thread id from event log text", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-complete-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    const runSpec = makeCodexRunSpec(request, paths, agentStateFor({ ...request, target_root: "different" }));

    const result = await resolveCompletedThreadId(
      runSpec,
      { ...request, data_dir: dataDir },
      paths,
      agentStateFor(request),
      0,
      `noise\n${JSON.stringify({ type: "thread.started", thread_id: "thread-new" })}\n`,
    );

    assert.equal(result.ok, true);
    assert.equal(result.threadId, "thread-new");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveCompletedThreadId fails initial completion when thread id is missing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-complete-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    const runSpec = makeCodexRunSpec(request, paths, agentStateFor({ ...request, target_root: "different" }));
    const agentState = agentStateFor(request);

    const result = await resolveCompletedThreadId(
      runSpec,
      { ...request, data_dir: dataDir },
      paths,
      agentState,
      0,
      `${JSON.stringify({ type: "other.event" })}\n`,
    );

    assert.equal(result.ok, false);
    assert.equal(result.result.response.error.code, "codex_thread_id_missing");
    const diagnostic = await readFile(paths.diagnosticFile, "utf8");
    assert.match(diagnostic, /thread.started event/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("resolveCompletedThreadId keeps resume thread id from run spec", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-complete-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp, { round: 2 });
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    const runSpec = makeCodexRunSpec(request, paths, agentStateFor(request));

    const result = await resolveCompletedThreadId(
      runSpec,
      { ...request, data_dir: dataDir },
      paths,
      agentStateFor(request),
      0,
      `${JSON.stringify({ type: "thread.started", thread_id: "unexpected" })}\n`,
    );

    assert.equal(result.ok, true);
    assert.equal(result.threadId, "thread-abc");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
