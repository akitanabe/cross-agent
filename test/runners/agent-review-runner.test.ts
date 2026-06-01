// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionPaths } from "../../src/core/agent-review/state.ts";
import { prepareInitialRound, startSession } from "../../src/core/agent-review/workflow.ts";
import { normalizePath } from "../../src/core/shared/path-utils.ts";
import { completeRoundFromEnvelope, writeAdapterResponse } from "../helpers/agent-review-fixtures.ts";
import { runNodeScript } from "../helpers/run-node-script.ts";

const runnerPath = fileURLToPath(new URL("../../plugin/scripts/agent-review-runner.mjs", import.meta.url));

function runRunner(args, input = "") {
  return runNodeScript(runnerPath, args, input);
}

test("start-session command writes review session id as text", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
      "--auto-deep-dive",
      "false",
    ]);

    assert.equal(result.stdout, "session-1\n");
    const paths = sessionPaths(dataDir, "session-1");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.review_session_id, "session-1");
    assert.equal(state.options.review_depth, "low");
    assert.equal(state.options.auto_deep_dive, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("start-session command accepts raw Windows path from argv", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
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

    const prepareOutput = JSON.parse(result.stdout);
    const adapterRequest = JSON.parse(await readFile(prepareOutput.requests[0].request_file, "utf8"));
    assert.equal(adapterRequest.round, 2);
    assert.equal(adapterRequest.round_kind, "deep_dive");
    assert.match(adapterRequest.prompt_file, /round-2-codex-prompt\.md$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepare-initial command reads context file and target files from argv", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
      "--agent-id",
      "codex",
      "--adapter",
      "codex",
      "--focus-question",
      "レビューして",
      "--context-file",
      contextFile,
      "--target-files",
      "src\\a.ts",
    ]);

    const prepareOutput = JSON.parse(result.stdout);
    const adapterRequest = JSON.parse(await readFile(prepareOutput.requests[0].request_file, "utf8"));
    assert.equal(adapterRequest.round, 1);
    assert.equal(adapterRequest.agent_id, "codex");
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
      "--agent-id",
      "codex",
      "--adapter",
      "codex",
    ]);

    const prepareOutput = JSON.parse(result.stdout);
    const adapterRequest = JSON.parse(await readFile(prepareOutput.requests[0].request_file, "utf8"));
    assert.equal(adapterRequest.context_file, normalizePath(contextFile));
    const copiedContext = await readFile(contextFile, "utf8");
    assert.equal(copiedContext, "# Auto Context\nhello\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("complete-round command records adapter response from response file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const result = await runRunner(["complete-round", "--data-dir", dataDir, "--response-file", responseFile]);

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.rounds[0].agents[0].agent_result.output_file, normalizePath(outputFile));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("complete-current-round command derives current adapter response file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const result = await runRunner([
      "complete-current-round",
      "--data-dir",
      dataDir,
      "--review-session-id",
      "session-1",
    ]);

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "completed");
    assert.equal(output.response_file, normalizePath(responseFile));
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.rounds[0].agents[0].agent_result.output_file, normalizePath(outputFile));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("get-round-output command writes text by default", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
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
