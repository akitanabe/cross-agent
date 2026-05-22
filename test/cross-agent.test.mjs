import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAdapterRequest,
  buildInitialPrompt,
  buildNextRoundPrompt,
  completeRound,
  getRound,
  getRoundOutput,
  normalizeOptions,
  prepareInitialRound,
  prepareNextRound,
  sessionPaths,
  startSession,
} from "../scripts/cross-agent-runner.mjs";
import { normalizePath } from "../scripts/path-utils.mjs";

const runnerPath = fileURLToPath(new URL("../scripts/cross-agent-runner.mjs", import.meta.url));

function runRunner(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`runner exited with ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}

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

test("buildNextRoundPrompt includes previous output, focus, and follow-up directions", () => {
  const prompt = buildNextRoundPrompt({
    promptText: "根拠が弱い指摘を検証して",
    previousOutputFile: "C:/data/round-1-output.md",
    focusQuestion: "この設計でよいか",
  });

  assert.match(prompt, /同じレビューセッションを継続/);
  assert.match(prompt, /C:\/data\/round-1-output\.md/);
  assert.match(prompt, /根拠が弱い指摘を検証して/);
  assert.match(prompt, /確信度が上がった点/);
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

test("startSession creates empty state", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    const result = await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { review_depth: "low", max_rounds: 1 },
    });

    const paths = sessionPaths(dataDir, "session-1");
    assert.deepEqual(result, { output_type: "text", content: "session-1" });

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.status, "active");
    assert.equal(state.current_round, 0);
    assert.equal(state.rounds.length, 0);
    assert.equal(state.artifacts.files.length, 0);
    assert.equal(state.options.review_depth, "low");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("start-session command writes review session id as text", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    const result = await runRunner(
      ["start-session"],
      `${JSON.stringify(
        {
          data_dir: dataDir,
          review_session_id: "session-1",
          target_root: targetRoot,
        },
        null,
        2,
      )}\n`,
    );

    assert.equal(result.stdout, "session-1\n");
    const paths = sessionPaths(dataDir, "session-1");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.review_session_id, "session-1");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("start-session command takes target_root from --target-root and normalizes it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    // target_root は JSON 本文に入れず argv で渡す。本文に backslash パスがないので
    // JSON.parse は落ちず、runner は argv の値を正規化して state に保存する。
    const result = await runRunner(
      ["start-session", "--target-root", targetRoot],
      `${JSON.stringify({ data_dir: dataDir, review_session_id: "session-flag" }, null, 2)}\n`,
    );

    assert.equal(result.stdout, "session-flag\n");
    const paths = sessionPaths(dataDir, "session-flag");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.target_root, normalizePath(targetRoot));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("start-session command prefers --target-root over the JSON body value", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const flagRoot = join(temp, "from-flag");
    const bodyRoot = join(temp, "from-body");
    const dataDir = join(temp, "data");
    await mkdir(flagRoot, { recursive: true });
    await mkdir(bodyRoot, { recursive: true });

    const result = await runRunner(
      ["start-session", "--target-root", flagRoot],
      `${JSON.stringify(
        { data_dir: dataDir, review_session_id: "session-pref", target_root: bodyRoot },
        null,
        2,
      )}\n`,
    );

    assert.equal(result.stdout, "session-pref\n");
    const paths = sessionPaths(dataDir, "session-pref");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.target_root, normalizePath(flagRoot));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareInitialRound creates prompt and adapter request", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { review_depth: "low", max_rounds: 1 },
    });

    const result = await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      agent: "codex",
      focus_question: "レビューして",
      context_text: "# Context\nhello",
      target_files: ["README.md"],
    });
    const adapterRequest = result.content;

    const paths = sessionPaths(dataDir, "session-1");
    assert.equal(result.output_type, "json");
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

test("prepareNextRound appends a deep dive round and adapter request", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { review_depth: "high", max_rounds: 2 },
    });
    await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      agent: "codex",
      focus_question: "設計判断を確認して",
      context_text: "context",
      target_files: ["src/a.ts"],
    });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "round 1 output", "utf8");
    await completeRound({
      data_dir: dataDir,
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const result = await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round_kind: "deep_dive",
      prompt_text: "Round 1 の重要指摘を批判的に検証して",
    });
    const adapterRequest = result.content;

    assert.equal(result.output_type, "json");
    assert.equal(adapterRequest.round, 2);
    assert.equal(adapterRequest.round_kind, "deep_dive");
    assert.equal(adapterRequest.agent, "codex");
    assert.equal(adapterRequest.context_file, join(paths.artifactDir, "context.md"));
    assert.deepEqual(adapterRequest.target_files, ["src/a.ts"]);
    assert.equal(adapterRequest.options.review_depth, "high");

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.current_round, 2);
    assert.equal(state.rounds.length, 2);
    assert.equal(state.rounds[1].kind, "deep_dive");
    assert.equal(state.rounds[1].agent_result, null);
    assert.equal(state.artifacts.files.length, 5);

    const prompt = await readFile(adapterRequest.prompt_file, "utf8");
    assert.match(prompt, /Round 1 の重要指摘/);
    assert.match(prompt, /round-1-codex-output\.md/);
    assert.match(prompt, /設計判断を確認して/);
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
    await completeRound({
      data_dir: dataDir,
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const result = await runRunner(
      ["prepare-next-round"],
      `${JSON.stringify(
        {
          data_dir: dataDir,
          review_session_id: "session-1",
          round_kind: "deep_dive",
          prompt_text: "もう少し掘り下げて",
        },
        null,
        2,
      )}\n`,
    );

    const adapterRequest = JSON.parse(result.stdout);
    assert.equal(adapterRequest.round, 2);
    assert.equal(adapterRequest.round_kind, "deep_dive");
    assert.match(adapterRequest.prompt_file, /round-2-prompt\.md$/);
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
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
    });
    const prepareResult = await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      context_text: "context",
    });
    const adapterRequest = prepareResult.content;

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    const result = await completeRound({
      data_dir: dataDir,
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [{ path: outputFile, kind: "agent_output", owner: "codex-adapter" }],
      error: null,
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

test("getRound returns round state", async () => {
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
    await writeFile(outputFile, "review output", "utf8");

    await completeRound({
      data_dir: dataDir,
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const output = await getRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round: 1,
    });

    assert.equal(output.output_file, outputFile);
    assert.equal(output.output_text, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("getRoundOutput returns text command output by default", async () => {
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
    await writeFile(outputFile, "review output", "utf8");

    await completeRound({
      data_dir: dataDir,
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const output = await getRoundOutput({
      data_dir: dataDir,
      review_session_id: "session-1",
      round: 1,
    });

    assert.deepEqual(output, { output_type: "text", content: "review output" });
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

    await completeRound({
      data_dir: dataDir,
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [],
      error: null,
    });

    const result = await runRunner(
      ["get-round-output"],
      `${JSON.stringify({ data_dir: dataDir, review_session_id: "session-1", round: 1 }, null, 2)}\n`,
    );

    assert.equal(result.stdout, "plain review output\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
