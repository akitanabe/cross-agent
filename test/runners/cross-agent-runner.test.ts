// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionPaths } from "../../src/core/cross-agent/state.ts";
import { prepareInitialRound, startSession } from "../../src/core/cross-agent/workflow.ts";
import { normalizePath } from "../../src/core/shared/path-utils.ts";
import { completeRoundFromEnvelope, writeAdapterResponse } from "../helpers/cross-agent-fixtures.ts";
import { runNodeScript } from "../helpers/run-node-script.ts";

const runnerPath = fileURLToPath(new URL("../../scripts/cross-agent-runner.mjs", import.meta.url));
const utilsRunnerPath = fileURLToPath(new URL("../../scripts/utils-runner.mjs", import.meta.url));

function runRunner(args, input = "") {
  return runNodeScript(runnerPath, args, input);
}

function runUtilsRunner(args, input = "") {
  return runNodeScript(utilsRunnerPath, args, input);
}

test("start-session command writes review session id as text", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    const result = await runRunner([
      "start-session",
      "--data-dir",
      dataDir,
      "--review-session-id",
      "session-1",
      "--target-root",
      targetRoot,
      "--review-depth",
      "low",
      "--max-rounds",
      "1",
    ]);

    assert.equal(result.stdout, "session-1\n");
    const paths = sessionPaths(dataDir, "session-1");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.review_session_id, "session-1");
    assert.equal(state.options.review_depth, "low");
    assert.equal(state.options.max_rounds, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("utils-runner normalize-path command converts paths according to host platform", async () => {
  // 汎用 path utility は runner CLI 以外でも使う。argv 経由なので backslash パスも
  // シェルがリテラルに渡し、utility が forward slash に変換して返す。
  // 期待値は host platform で確定させる: win32 なら backslash → forward slash、posix なら no-op。
  const raw = "C:\\Users\\example\\Projects\\sample-repo";
  const result = await runUtilsRunner(["normalize-path", raw]);
  if (process.platform === "win32") {
    assert.equal(result.stdout, "C:/Users/example/Projects/sample-repo\n");
  } else {
    assert.equal(result.stdout, `${raw}\n`);
  }
});


test("utils-runner normalize-path command supports multiple path arguments", async () => {
  const result = await runUtilsRunner(["normalize-path", "C:\\repo", "src\\a.ts", "src\\b.ts"]);
  if (process.platform === "win32") {
    assert.equal(result.stdout, "C:/repo\nsrc/a.ts\nsrc/b.ts\n");
  } else {
    assert.equal(result.stdout, "C:\\repo\nsrc\\a.ts\nsrc\\b.ts\n");
  }
});


test("utils-runner normalize-path command requires at least one path", async () => {
  await assert.rejects(runUtilsRunner(["normalize-path"]), /normalize-path requires at least one path/);
});


test("start-session command accepts raw Windows path from argv", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    await runRunner([
      "start-session",
      "--data-dir",
      dataDir,
      "--review-session-id",
      "session-1",
      "--target-root",
      targetRoot,
    ]);

    const paths = sessionPaths(dataDir, "session-1");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.target_root, normalizePath(targetRoot));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("prepare-next-round command writes adapter request JSON", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
    });
    await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
    });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "round 1 output", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const promptFile = join(temp, "next-prompt.md");
    await writeFile(promptFile, "もう少し掘り下げて", "utf8");
    const result = await runRunner([
      "prepare-next-round",
      "--data-dir",
      dataDir,
      "--review-session-id",
      "session-1",
      "--round-kind",
      "deep_dive",
      "--prompt-file",
      promptFile,
    ]);

    const adapterRequest = JSON.parse(await readFile(result.stdout.trim(), "utf8"));
    assert.equal(adapterRequest.round, 2);
    assert.equal(adapterRequest.round_kind, "deep_dive");
    assert.match(adapterRequest.prompt_file, /round-2-prompt\.md$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("prepare-initial command reads context file and target files from argv", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
    });

    const contextFile = join(temp, "context.md");
    await writeFile(contextFile, "# Context\nhello", "utf8");
    const result = await runRunner([
      "prepare-initial",
      "--data-dir",
      dataDir,
      "--review-session-id",
      "session-1",
      "--agent",
      "codex",
      "--focus-question",
      "レビューして",
      "--context-file",
      contextFile,
      "--target-files",
      "src\\a.ts",
    ]);

    const adapterRequest = JSON.parse(await readFile(result.stdout.trim(), "utf8"));
    assert.equal(adapterRequest.round, 1);
    assert.equal(adapterRequest.agent, "codex");
    assert.equal(adapterRequest.focus_question, "レビューして");
    assert.deepEqual(adapterRequest.target_files, process.platform === "win32" ? ["src/a.ts"] : ["src\\a.ts"]);

    const paths = sessionPaths(dataDir, "session-1");
    const copiedContext = await readFile(join(paths.artifactDir, "context.md"), "utf8");
    assert.equal(copiedContext, "# Context\nhello\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("prepare-initial command auto reads session context file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
    });

    const paths = sessionPaths(dataDir, "session-1");
    const contextFile = join(paths.artifactDir, "context.md");
    await writeFile(contextFile, "# Auto Context\nhello", "utf8");

    const result = await runRunner([
      "prepare-initial",
      "--data-dir",
      dataDir,
      "--review-session-id",
      "session-1",
      "--agent",
      "codex",
    ]);

    const adapterRequest = JSON.parse(await readFile(result.stdout.trim(), "utf8"));
    assert.equal(adapterRequest.context_file, normalizePath(contextFile));
    const copiedContext = await readFile(contextFile, "utf8");
    assert.equal(copiedContext, "# Auto Context\nhello\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("complete-round command records adapter response from response file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
    });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    const responseFile = join(paths.artifactDir, "round-1-codex-response.json");
    await writeAdapterResponse(responseFile, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const result = await runRunner([
      "complete-round",
      "--data-dir",
      dataDir,
      "--response-file",
      responseFile,
    ]);

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.rounds[0].agent_result.output_file, normalizePath(outputFile));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("get-round-output command writes text by default", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
    });
    await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
    });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "plain review output", "utf8");

    await completeRoundFromEnvelope(dataDir, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const result = await runRunner([
      "get-round-output",
      "--data-dir",
      dataDir,
      "--review-session-id",
      "session-1",
      "--round",
      "1",
    ]);

    assert.equal(result.stdout, "plain review output\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
