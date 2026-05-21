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
} from "../scripts/cross-agent.mjs";

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
    stateFile: "C:/data/sessions/session-1.json",
    promptFile: "C:/data/artifacts/session-1/round-1-prompt.md",
    contextFile: null,
    targetFiles: [],
    focusQuestion: null,
    options: normalizeOptions(),
  });

  assert.equal(request.contract_version, 1);
  assert.equal(request.review_session_id, "session-1");
  assert.equal(request.options.review_depth, "medium");
});

test("prepareInitialSession creates state, prompt, and adapter request", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    const result = await prepareInitialSession({
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
    assert.equal(result.state_file, paths.stateFile);
    assert.equal(result.adapter_request.agent, "codex");
    assert.equal(result.adapter_request.options.review_depth, "low");

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.current_round, 1);
    assert.equal(state.rounds[0].agent_result, null);
    assert.equal(state.artifacts.files.length, 3);

    const prompt = await readFile(result.prompt_file, "utf8");
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
    const prepared = await prepareInitialSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      context_text: "context",
    });

    const outputFile = join(prepared.artifact_dir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    const result = await completeRound({
      state_file: prepared.state_file,
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
    const state = JSON.parse(await readFile(prepared.state_file, "utf8"));
    assert.equal(state.rounds[0].agent_result.output_file, outputFile);
    assert.equal(state.artifacts.files.every((entry) => entry.owner === "cross-agent"), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
