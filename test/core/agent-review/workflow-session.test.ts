// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionPaths } from "../../../src/core/agent-review/state.ts";
import { prepareInitialRound, prepareNextRound } from "../../../src/core/agent-review/workflow-prepare.ts";
import { startSession } from "../../../src/core/agent-review/workflow-session.ts";
import { normalizePath } from "../../../src/core/shared/path-utils.ts";
import { completeRoundFromEnvelope } from "../../helpers/agent-review-fixtures.ts";

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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });

    const result = await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { review_depth: "low" },
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

test("prepareInitialRound rejects unsupported session schema version", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    const paths = sessionPaths(dataDir, "session-1");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    state.schema_version = 1;
    await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    await assert.rejects(
      prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" }),
      /unsupported agent-review session schema_version/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareInitialRound creates prompt and adapter request", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { review_depth: "low" },
    });

    const result = await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      focus_question: "レビューして",
      context_text: "# Context\nhello",
      target_files: ["README.md"],
    });
    const adapterRequest = result.envelopes[0];

    const paths = sessionPaths(dataDir, "session-1");
    assert.equal(result.output_type, "json");
    assert.equal(result.content.requests[0].request_file, normalizePath(join(paths.artifactDir, "round-1-codex-adapter-request.json")));
    assert.equal(adapterRequest.review_session_id, "session-1");
    assert.equal(adapterRequest.agent_id, "codex");
    assert.equal(adapterRequest.adapter, "codex");
    assert.equal(adapterRequest.state_file, undefined);
    assert.equal(adapterRequest.agent_state_file, undefined);
    assert.equal(adapterRequest.options.review_depth, "low");
    assert.equal(adapterRequest.prompt_file, normalizePath(adapterRequest.prompt_file));
    assert.equal(adapterRequest.context_file, normalizePath(adapterRequest.context_file));

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.current_round, 1);
    assert.equal(state.agent_state_files, undefined);
    assert.equal(state.agents, undefined);
    assert.equal(state.rounds[0].agents[0].agent_result, null);
    assert.equal(state.context.context_file, normalizePath(state.context.context_file));
    assert.equal(state.context.initial_prompt_file, normalizePath(state.context.initial_prompt_file));
    assert.equal(state.rounds[0].agents[0].prompt_file, normalizePath(state.rounds[0].agents[0].prompt_file));
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({
      data_dir: dataDir,
      review_session_id: "session-1",
      target_root: targetRoot,
      options: { review_depth: "high" },
    });
    await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      focus_question: "設計判断を確認して",
      context_text: "context",
      target_files: ["src/a.ts"],
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

    const result = await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round_kind: "deep_dive",
      prompt_text: "Round 1 の重要指摘を批判的に検証して",
    });
    const adapterRequest = result.envelopes[0];

    assert.equal(result.output_type, "json");
    assert.equal(adapterRequest.round, 2);
    assert.equal(adapterRequest.round_kind, "deep_dive");
    assert.equal(adapterRequest.agent_id, "codex");
    assert.equal(adapterRequest.context_file, normalizePath(join(paths.artifactDir, "context.md")));
    assert.equal(adapterRequest.prompt_file, normalizePath(adapterRequest.prompt_file));
    assert.deepEqual(adapterRequest.target_files, ["src/a.ts"]);
    assert.equal(adapterRequest.options.review_depth, "high");

    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.current_round, 2);
    assert.equal(state.rounds.length, 2);
    assert.equal(state.rounds[1].kind, "deep_dive");
    assert.equal(state.rounds[1].agents[0].agent_result, null);
    assert.equal(
      state.rounds[0].agents[0].agent_result.output_file,
      normalizePath(state.rounds[0].agents[0].agent_result.output_file),
    );
    assert.equal(state.rounds[1].agents[0].prompt_file, normalizePath(state.rounds[1].agents[0].prompt_file));
    assert.equal(state.artifacts.files.length, 5);

    const prompt = await readFile(adapterRequest.prompt_file, "utf8");
    assert.match(prompt, /Round 1 の重要指摘/);
    assert.match(prompt, /round-1-codex-output\.md/);
    assert.match(prompt, /設計判断を確認して/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound rejects deep_dive when previous round failed", async () => {
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
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
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
      /deep_dive requires previous status=completed/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound rejects recovery when previous round completed", async () => {
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
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
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
      /recovery requires previous status=failed/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound allows explicit deep_dive after follow_up", async () => {
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
    const round1Output = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(round1Output, "round 1", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      round: 1,
      status: "completed",
      output_file: round1Output,
    });

    await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round_kind: "follow_up",
      prompt_text: "ユーザー追加質問",
    });
    const round2Output = join(paths.artifactDir, "round-2-codex-output.md");
    await writeFile(round2Output, "round 2", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      round: 2,
      status: "completed",
      output_file: round2Output,
    });

    const result = await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      round_kind: "deep_dive",
      prompt_text: "ユーザーが明示した追加 deep_dive は通る",
    });
    assert.equal(result.envelopes[0].round, 3);
    assert.equal(result.envelopes[0].round_kind, "deep_dive");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareNextRound follow_up allows a new agent_id with explicit previous_agent_id", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      agents: [
        { agent_id: "codex-a", adapter: "codex" },
        { agent_id: "codex-b", adapter: "codex" },
      ],
    });
    const paths = sessionPaths(dataDir, "session-1");
    for (const agentId of ["codex-a", "codex-b"]) {
      const outputFile = join(paths.artifactDir, `round-1-${agentId}-output.md`);
      await writeFile(outputFile, `${agentId} output`, "utf8");
      await completeRoundFromEnvelope(dataDir, {
        contract_version: 2,
        review_session_id: "session-1",
        agent_id: agentId,
        adapter: "codex",
        round: 1,
        status: "completed",
        output_file: outputFile,
      });
    }

    await assert.rejects(
      prepareNextRound({
        data_dir: dataDir,
        review_session_id: "session-1",
        agent_id: "claude-reviewer",
        adapter: "claude",
        prompt_text: "Claude で追加確認",
      }),
      /previous output is ambiguous/,
    );

    const result = await prepareNextRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      agent_id: "claude-reviewer",
      adapter: "claude",
      previous_agent_id: "codex-b",
      prompt_text: "Claude で追加確認",
    });

    assert.equal(result.envelopes[0].agent_id, "claude-reviewer");
    assert.equal(result.envelopes[0].adapter, "claude");
    const prompt = await readFile(result.envelopes[0].prompt_file, "utf8");
    assert.match(prompt, /round-1-codex-b-output\.md/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("startSession rejects unsafe review_session_id input", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
