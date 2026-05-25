// @ts-nocheck
import { expect, test } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAdapterRequest } from "../src/core/cross-agent/envelope.ts";
import { buildInitialPrompt, buildNextRoundPrompt } from "../src/core/cross-agent/prompts.ts";
import { normalizeOptions, sessionPaths } from "../src/core/cross-agent/state.ts";
import {
  completeRound,
  getRound,
  getRoundOutput,
  prepareInitialRound,
  prepareNextRound,
  startSession,
} from "../src/core/cross-agent/workflow.ts";
import { normalizePath } from "../src/core/shared/path-utils.ts";

const runnerPath = fileURLToPath(new URL("../scripts/cross-agent-runner.mjs", import.meta.url));
const utilsRunnerPath = fileURLToPath(new URL("../scripts/utils-runner.mjs", import.meta.url));

function runNodeScript(scriptPath, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
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

function runRunner(args, input = "") {
  return runNodeScript(runnerPath, args, input);
}

async function writeAdapterResponse(filePath, response) {
  await writeFile(filePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
}

async function completeRoundFromEnvelope(dataDir, response) {
  const paths = sessionPaths(dataDir, response.review_session_id);
  const responseFile = join(paths.artifactDir, `round-${response.round}-${response.agent}-response.json`);
  await writeAdapterResponse(responseFile, response);
  return completeRound({ data_dir: dataDir, response_file: responseFile });
}

function runUtilsRunner(args, input = "") {
  return runNodeScript(utilsRunnerPath, args, input);
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

test("startSession throws when data_dir is missing (no env var fallback)", async () => {
  // 公式仕様 (plugins-reference) では ${CLAUDE_PLUGIN_DATA} は skill content の
  // substitution であり Bash tool には env var として export されない。よって SKILL から
  // 来る data_dir を唯一のソースとし、env var フォールバックは持たない契約。
  await assert.rejects(
    startSession({ review_session_id: "no-data-dir", target_root: tmpdir() }),
    /data_dir is required/,
  );
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
    const adapterRequest = result.envelope;

    const paths = sessionPaths(dataDir, "session-1");
    assert.equal(result.output_type, "text");
    assert.equal(result.content, normalizePath(join(paths.artifactDir, "round-1-adapter-request.json")));
    assert.equal(adapterRequest.review_session_id, "session-1");
    assert.equal(adapterRequest.agent, "codex");
    assert.equal(adapterRequest.state_file, undefined);
    assert.equal(adapterRequest.agent_state_file, undefined);
    assert.equal(adapterRequest.options.review_depth, "low");
    assert.equal(adapterRequest.prompt_file, normalizePath(adapterRequest.prompt_file));
    assert.equal(adapterRequest.context_file, normalizePath(adapterRequest.context_file));

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.current_round, 1);
    assert.equal(state.agent_state_files, undefined);
    assert.equal(state.agents, undefined);
    assert.equal(state.rounds[0].agent_result, null);
    assert.equal(state.context.context_file, normalizePath(state.context.context_file));
    assert.equal(state.context.initial_prompt_file, normalizePath(state.context.initial_prompt_file));
    assert.equal(state.rounds[0].prompt_file, normalizePath(state.rounds[0].prompt_file));
    assert.equal(
      state.artifacts.files.every((entry) => entry.path === normalizePath(entry.path)),
      true,
    );
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

    const result = await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round_kind: "deep_dive",
      prompt_text: "Round 1 の重要指摘を批判的に検証して",
    });
    const adapterRequest = result.envelope;

    assert.equal(result.output_type, "text");
    assert.equal(adapterRequest.round, 2);
    assert.equal(adapterRequest.round_kind, "deep_dive");
    assert.equal(adapterRequest.agent, "codex");
    assert.equal(adapterRequest.context_file, normalizePath(join(paths.artifactDir, "context.md")));
    assert.equal(adapterRequest.prompt_file, normalizePath(adapterRequest.prompt_file));
    assert.deepEqual(adapterRequest.target_files, ["src/a.ts"]);
    assert.equal(adapterRequest.options.review_depth, "high");

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.current_round, 2);
    assert.equal(state.rounds.length, 2);
    assert.equal(state.rounds[1].kind, "deep_dive");
    assert.equal(state.rounds[1].agent_result, null);
    assert.equal(state.rounds[0].agent_result.output_file, normalizePath(state.rounds[0].agent_result.output_file));
    assert.equal(state.rounds[1].prompt_file, normalizePath(state.rounds[1].prompt_file));
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
    const adapterRequest = prepareResult.envelope;

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    const result = await completeRoundFromEnvelope(dataDir, {
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
    assert.equal(state.rounds[0].agent_result.output_file, normalizePath(outputFile));
    assert.equal(state.rounds[0].agent_result.agent_state_file, undefined);
    assert.equal(state.artifacts.files.every((entry) => entry.owner === "cross-agent"), true);
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

test("completeRound rejects response_file outside artifact root", async () => {
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

    const responseFile = join(temp, "outside-response.json");
    await writeAdapterResponse(responseFile, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "failed",
      output_file: null,
      artifacts: [],
      error: { message: "outside" },
    });

    await assert.rejects(
      completeRound({ data_dir: dataDir, response_file: responseFile }),
      /outside artifact root/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound rejects deep_dive when previous round failed", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { max_rounds: 2 },
    });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "failed",
      error: { message: "codex CLI exited 1" },
    });

    await assert.rejects(
      prepareNextRound({
        data_dir: dataDir,
        review_session_id: "session-1",
        round_kind: "deep_dive",
        prompt_text: "深掘りを試みる",
      }),
      /deep_dive requires previous round status=completed/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound rejects recovery when previous round completed", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { max_rounds: 2 },
    });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
    });

    await assert.rejects(
      prepareNextRound({
        data_dir: dataDir,
        review_session_id: "session-1",
        round_kind: "recovery",
        prompt_text: "成功 round を復旧する",
      }),
      /recovery requires previous round status=failed/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound max_rounds does not count follow_up rounds", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { max_rounds: 2 },
    });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const round1Output = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(round1Output, "round 1", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: round1Output,
    });

    await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round_kind: "follow_up",
      prompt_text: "ユーザー追加質問 (consumed=1 のまま残る想定)",
    });
    const round2Output = join(paths.artifactDir, "round-2-codex-output.md");
    await writeFile(round2Output, "round 2", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 2,
      status: "completed",
      output_file: round2Output,
    });

    const result = await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round_kind: "deep_dive",
      prompt_text: "follow_up 後の deep_dive は通る (consumed=1, max=2)",
    });
    assert.equal(result.envelope.round, 3);
    assert.equal(result.envelope.round_kind, "deep_dive");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound max_rounds blocks deep_dive when budget exhausted", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { max_rounds: 1 },
    });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
    });

    await assert.rejects(
      prepareNextRound({
        data_dir: dataDir,
        review_session_id: "session-1",
        round_kind: "deep_dive",
        prompt_text: "max_rounds=1 では deep_dive は通らない",
      }),
      /max_rounds exceeded/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("sessionPaths rejects review_session_id with path traversal", () => {
  assert.throws(() => sessionPaths("/tmp/data", "../escape"), /invalid review_session_id/);
  assert.throws(() => sessionPaths("/tmp/data", "foo/bar"), /invalid review_session_id/);
  assert.throws(() => sessionPaths("/tmp/data", "foo\\bar"), /invalid review_session_id/);
  assert.throws(() => sessionPaths("/tmp/data", ".."), /invalid review_session_id/);
  assert.throws(() => sessionPaths("/tmp/data", ""), /non-empty string/);
});

test("sessionPaths accepts UUID and other safe ids", () => {
  assert.doesNotThrow(() => sessionPaths("/tmp/data", "829c6ad2-d23e-4bd3-9b81-44dfce08e9a8"));
  assert.doesNotThrow(() => sessionPaths("/tmp/data", "session-1"));
  assert.doesNotThrow(() => sessionPaths("/tmp/data", "v1.2_test"));
});

test("startSession rejects unsafe review_session_id input", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    await assert.rejects(
      startSession({ data_dir: dataDir, review_session_id: "../escape", target_root: targetRoot }),
      /invalid review_session_id/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects non-integer round number", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    for (const bad of ["1", 0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        completeRoundFromEnvelope(dataDir, {
          contract_version: 1,
          review_session_id: "session-1",
          agent: "codex",
          round: bad,
          status: "failed",
        }),
        /invalid round/,
        `expected invalid round for ${String(bad)}`,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("getRound rejects non-integer round number", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    await assert.rejects(
      getRound({ data_dir: dataDir, review_session_id: "session-1", round: "1" }),
      /invalid round/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects unsupported contract_version", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 2,
        review_session_id: "session-1",
        agent: "codex",
        round: 1,
        status: "completed",
        output_file: outputFile,
      }),
      /contract_version/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects unknown status", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 1,
        review_session_id: "session-1",
        agent: "codex",
        round: 1,
        status: "succeeded",
      }),
      /unknown status/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects output_file outside artifact dir", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const strayFile = join(temp, "outside.md");
    await writeFile(strayFile, "outside artifact dir", "utf8");

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 1,
        review_session_id: "session-1",
        agent: "codex",
        round: 1,
        status: "completed",
        output_file: strayFile,
      }),
      /outside artifact dir/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects completed status without output_file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 1,
        review_session_id: "session-1",
        agent: "codex",
        round: 1,
        status: "completed",
      }),
      /completed requires output_file/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects failed status carrying output_file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 1,
        review_session_id: "session-1",
        agent: "codex",
        round: 1,
        status: "failed",
        output_file: outputFile,
      }),
      /must not include output_file/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects missing output_file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "cross-agent-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const missingFile = join(paths.artifactDir, "round-1-codex-output.md");

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 1,
        review_session_id: "session-1",
        agent: "codex",
        round: 1,
        status: "completed",
        output_file: missingFile,
      }),
      /output_file does not exist/,
    );
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

    const output = await getRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round: 1,
    });

    assert.equal(output.output_file, normalizePath(outputFile));
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
