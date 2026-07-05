// @ts-nocheck

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { artifactDirFor, artifactPaths } from "../../../src/core/codex-adapter/state.ts";
import {
  loadRunSpecForComplete,
  makeCodexRunSpec,
  mismatchedRunSpecPath,
  readCodexExit,
} from "../../../src/core/codex-adapter/workflow-run-spec.ts";
import { createRequestFixture } from "../../helpers/codex-adapter-fixtures.ts";

// thread 未確立の agent では、新規 Codex exec 用 spec と非対話 approval policy を作る。
test("makeCodexRunSpec creates initial spec when agent has no thread", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);

    const runSpec = makeCodexRunSpec(request, paths, {
      review_session_id: request.review_session_id,
      agent: "codex",
      status: "pending",
      thread_id: null,
      target_root: null,
      last_output_file: null,
      last_event_log: null,
      last_exit_file: null,
      last_error: null,
      artifacts: [],
      errors: [],
    });

    assert.equal(runSpec.mode, "initial");
    assert.equal(runSpec.thread_id, null);
    assert.equal(runSpec.model_reasoning_effort, "high");
    assert.equal(runSpec.decision_reason, "missing_thread_id");
    assert.equal(runSpec.skip_git_repo_check, true);
    assert.equal(runSpec.ask_for_approval, "never");
    assert.equal("sandbox" in runSpec, false);
    assert.match(runSpec.output_file, /round-1-codex-output\.md$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// 既存 thread と同じ target root では、resume spec でも承認待ちを起こさない approval policy を維持する。
test("makeCodexRunSpec resumes when thread and target root match", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp, { round: 2 });
    request.options.review_depth = "surprise";
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);

    const runSpec = makeCodexRunSpec(request, paths, {
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
    });

    assert.equal(runSpec.mode, "resume");
    assert.equal(runSpec.thread_id, "thread-abc");
    assert.equal(runSpec.model_reasoning_effort, "high");
    assert.match(runSpec.warning, /Unknown review_depth/);
    assert.equal(runSpec.decision_reason, "resume");
    assert.equal(runSpec.ask_for_approval, "never");
    assert.equal("sandbox" in runSpec, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// complete 側は runner が生成した run spec を検証し、response path を data dir から導出する。
test("loadRunSpecForComplete returns validated spec and derived paths", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    await mkdir(artifactDirFor(dataDir, request.review_session_id), { recursive: true });
    const runSpec = makeCodexRunSpec(request, paths, {
      review_session_id: request.review_session_id,
      agent: "codex",
      status: "pending",
      thread_id: null,
      target_root: null,
      last_output_file: null,
      last_event_log: null,
      last_exit_file: null,
      last_error: null,
      artifacts: [],
      errors: [],
    });
    await writeFile(paths.runFile, `${JSON.stringify(runSpec, null, 2)}\n`, "utf8");

    const loaded = await loadRunSpecForComplete(paths.runFile, dataDir);

    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.runSpec.review_session_id, request.review_session_id);
    assert.equal(loaded.value.request.data_dir, dataDir);
    assert.equal(loaded.value.paths.responseFile, paths.responseFile);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// approval policy が欠落した古い run spec は、承認待ち loop を避けるため invalid として fail-fast する。
test("loadRunSpecForComplete rejects run spec without approval policy", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const artifactDir = artifactDirFor(dataDir, request.review_session_id);
    const paths = artifactPaths(artifactDir, request.round);
    await mkdir(artifactDir, { recursive: true });
    const runSpec = makeCodexRunSpec(request, paths, {
      review_session_id: request.review_session_id,
      agent: "codex",
      status: "pending",
      thread_id: null,
      target_root: null,
      last_output_file: null,
      last_event_log: null,
      last_exit_file: null,
      last_error: null,
      artifacts: [],
      errors: [],
    });
    delete runSpec.ask_for_approval;
    await writeFile(paths.runFile, `${JSON.stringify(runSpec, null, 2)}\n`, "utf8");

    const loaded = await loadRunSpecForComplete(paths.runFile, dataDir);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.result.response.error.code, "codex_run_spec_invalid");
    assert.match(loaded.result.response.error.message, /ask_for_approval/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// 不正な approval policy は、Codex CLI を起動する前に invalid spec として止める。
test("loadRunSpecForComplete rejects unsupported approval policy", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const artifactDir = artifactDirFor(dataDir, request.review_session_id);
    const paths = artifactPaths(artifactDir, request.round);
    await mkdir(artifactDir, { recursive: true });
    const runSpec = makeCodexRunSpec(request, paths, {
      review_session_id: request.review_session_id,
      agent: "codex",
      status: "pending",
      thread_id: null,
      target_root: null,
      last_output_file: null,
      last_event_log: null,
      last_exit_file: null,
      last_error: null,
      artifacts: [],
      errors: [],
    });
    runSpec.ask_for_approval = "on-request";
    await writeFile(paths.runFile, `${JSON.stringify(runSpec, null, 2)}\n`, "utf8");

    const loaded = await loadRunSpecForComplete(paths.runFile, dataDir);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.result.response.error.code, "codex_run_spec_invalid");
    assert.match(loaded.result.response.error.message, /ask_for_approval/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// 壊れた run spec は Codex CLI へ渡さず、recoverable な failed response に変換する。
test("loadRunSpecForComplete turns invalid spec into failed response", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const { dataDir } = await createRequestFixture(temp);
    const artifactDir = artifactDirFor(dataDir, "session-1");
    const runFile = join(artifactDir, "round-1-codex-run.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(runFile, `${JSON.stringify({ schema_version: 1, kind: "wrong", round: 1 }, null, 2)}\n`, "utf8");

    const loaded = await loadRunSpecForComplete(runFile, dataDir);

    assert.equal(loaded.ok, false);
    assert.equal(loaded.result.response.status, "failed");
    assert.equal(loaded.result.response.error.code, "codex_run_spec_invalid");
    assert.match(loaded.result.path, /round-1-codex-response\.json$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// complete 前の path 検証では、run spec が別 artifact path へ差し替えられていないか検出する。
test("mismatchedRunSpecPath reports the first derived path mismatch", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);
    const runSpec = makeCodexRunSpec(request, paths, {
      review_session_id: request.review_session_id,
      agent: "codex",
      status: "pending",
      thread_id: null,
      target_root: null,
      last_output_file: null,
      last_event_log: null,
      last_exit_file: null,
      last_error: null,
      artifacts: [],
      errors: [],
    });
    runSpec.event_log = join(temp, "wrong-events.jsonl");

    assert.equal(mismatchedRunSpecPath(runSpec, paths), "event_log");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

// exit artifact は Codex CLI の終了コードだけを受け付け、壊れた形は完了処理で拒否する。
test("readCodexExit accepts numeric code and rejects malformed exit file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-run-spec-"));
  try {
    const exitFile = join(temp, "exit.json");
    await writeFile(exitFile, `${JSON.stringify({ code: 3 }, null, 2)}\n`, "utf8");
    assert.deepEqual(await readCodexExit(exitFile), { code: 3 });

    await writeFile(exitFile, `${JSON.stringify({ code: "3" }, null, 2)}\n`, "utf8");
    await assert.rejects(() => readCodexExit(exitFile), /numeric code/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
