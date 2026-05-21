import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAdapterRequest,
  buildInitialPrompt,
  completeRound,
  normalizeOptions,
  prepareInitialSession,
  sessionPaths,
} from "../scripts/cross-agent-runner.mjs";

test("normalizeOptions fills defaults", () => {
  assert.deepEqual(normalizeOptions({ review_depth: "high" }), {
    max_rounds: 2,
    auto_deep_dive: true,
    review_depth: "high",
    keep_artifacts: false,
  });
});

test("buildInitialPrompt includes focus, context, target files, and review viewpoints", () => {
  const prompt = buildInitialPrompt({
    focusQuestion: "この設計でよいか",
    contextFile: "C:/data/context.md",
    targetFiles: ["src/a.ts", "src/b.ts"],
  });

  assert.match(prompt, /この設計でよいか/);
  assert.match(prompt, /C:\/data\/context\.md/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /見落としているリスク/);
});

test("buildAdapterRequest creates v1 envelope", () => {
  const request = buildAdapterRequest({
    reviewSessionId: "session-1",
    agent: "codex",
    round: 1,
    roundKind: "initial_review",
    targetRoot: "C:/repo",
    promptFile: "C:/data/artifacts/session-1/round-1-prompt.md",
    contextFile: null,
    targetFiles: [],
    focusQuestion: null,
    options: normalizeOptions(),
  });

  assert.equal(request.contract_version, 1);
  assert.equal(request.review_session_id, "session-1");
  assert.equal(request.state_file, undefined);
  assert.equal(request.agent_state_file, undefined);
  assert.equal(request.options.review_depth, "medium");
});

test("prepareInitialSession creates state, prompt, and adapter request", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    const adapterRequest = await prepareInitialSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      agent: "codex",
      target_root: targetRoot,
      focus_question: "レビューして",
      context_text: "# Context\nhello",
      target_files: ["README.md"],
      options: { review_depth: "low", max_rounds: 1 },
    });

    const paths = sessionPaths(dataDir, "session-1");
    assert.equal(adapterRequest.review_session_id, "session-1");
    assert.equal(adapterRequest.agent, "codex");
    assert.equal(adapterRequest.state_file, undefined);
    assert.equal(adapterRequest.agent_state_file, undefined);
    assert.equal(adapterRequest.options.review_depth, "low");

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.current_round, 1);
    assert.equal(state.agent_state_files, undefined);
    assert.equal(state.agents, undefined);
    assert.equal(state.rounds[0].agent_result, null);
    assert.equal(state.artifacts.files.length, 3);

    const prompt = await readFile(adapterRequest.prompt_file, "utf8");
    assert.match(prompt, /レビューして/);
    assert.match(prompt, /README\.md/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound records adapter response into state", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    const adapterRequest = await prepareInitialSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      context_text: "context",
    });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    const result = await completeRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      response: {
        contract_version: 1,
        review_session_id: "session-1",
        agent: "codex",
        round: 1,
        status: "completed",
        output_file: outputFile,
        artifacts: [{ path: outputFile, kind: "agent_output", owner: "codex-adapter" }],
        error: null,
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(adapterRequest.review_session_id, "session-1");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.rounds[0].agent_result.output_file, outputFile);
    assert.equal(state.rounds[0].agent_result.agent_state_file, undefined);
    assert.equal(state.artifacts.files.every((entry) => entry.owner === "cross-agent"), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
