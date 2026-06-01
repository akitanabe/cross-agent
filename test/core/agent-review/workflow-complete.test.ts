// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionPaths } from "../../../src/core/agent-review/state.ts";
import { completeCurrentRound, completeRound } from "../../../src/core/agent-review/workflow-complete.ts";
import { prepareInitialRound } from "../../../src/core/agent-review/workflow-prepare.ts";
import { getRound, getRoundOutput } from "../../../src/core/agent-review/workflow-round.ts";
import { startSession } from "../../../src/core/agent-review/workflow-session.ts";
import { normalizePath } from "../../../src/core/shared/path-utils.ts";
import { completeRoundFromEnvelope, writeAdapterResponse } from "../../helpers/agent-review-fixtures.ts";

test("completeRound records adapter response into state", async () => {
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
    const prepareResult = await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      context_text: "context",
    });
    const adapterRequest = prepareResult.envelopes[0];

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");

    const result = await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      round: 1,
      status: "completed",
      output_file: outputFile,
      artifacts: [{ path: outputFile, kind: "agent_output", owner: "codex-adapter" }],
      error: null,
    });

    assert.equal(result.status, "completed");
    assert.equal(adapterRequest.review_session_id, "session-1");
    const state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.rounds[0].agents[0].agent_result.output_file, normalizePath(outputFile));
    assert.equal(state.rounds[0].agents[0].agent_result.agent_state_file, undefined);
    assert.equal(
      state.artifacts.files.every((entry) => entry.owner === "agent-review"),
      true,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeCurrentRound derives the response file from current state", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    const paths = sessionPaths(dataDir, "session-1");
    const outputFile = join(paths.artifactDir, "round-1-codex-output.md");
    await writeFile(outputFile, "ok", "utf8");
    await writeAdapterResponse(join(paths.artifactDir, "round-1-codex-response.json"), {
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

    const result = await completeCurrentRound({ data_dir: dataDir, review_session_id: "session-1" });

    assert.equal(result.status, "completed");
    assert.equal(result.response_file, normalizePath(join(paths.artifactDir, "round-1-codex-response.json")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("multiple agents in one round complete independently", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    const prepared = await prepareInitialRound({
      data_dir: dataDir,
      review_session_id: "session-1",
      agents: [
        { agent_id: "codex-a", adapter: "codex" },
        { agent_id: "codex-b", adapter: "codex" },
        { agent_id: "claude-reviewer", adapter: "claude" },
      ],
    });

    assert.deepEqual(
      prepared.requests.map((request) => request.agent_id),
      ["codex-a", "codex-b", "claude-reviewer"],
    );
    const paths = sessionPaths(dataDir, "session-1");
    let state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.rounds.length, 1);
    assert.deepEqual(
      state.rounds[0].agents.map((agent) => agent.status),
      ["pending", "pending", "pending"],
    );

    const codexAOutput = join(paths.artifactDir, "round-1-codex-a-output.md");
    await writeFile(codexAOutput, "codex-a output", "utf8");
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex-a",
      adapter: "codex",
      round: 1,
      status: "completed",
      output_file: codexAOutput,
      artifacts: [],
      error: null,
    });

    state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.equal(state.rounds[0].completed_at, null);
    assert.equal(state.rounds[0].agents.find((agent) => agent.agent_id === "codex-a").status, "completed");
    assert.equal(state.rounds[0].agents.find((agent) => agent.agent_id === "codex-b").status, "pending");
    assert.equal(state.rounds[0].agents.find((agent) => agent.agent_id === "claude-reviewer").status, "pending");

    await assert.rejects(
      completeCurrentRound({ data_dir: dataDir, review_session_id: "session-1" }),
      /ambiguous or missing/,
    );

    await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex-b",
      adapter: "codex",
      round: 1,
      status: "failed",
      output_file: null,
      artifacts: [],
      error: { message: "failed" },
    });
    await completeRoundFromEnvelope(dataDir, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "claude-reviewer",
      adapter: "claude",
      round: 1,
      status: "skipped",
      output_file: null,
      artifacts: [],
      error: null,
    });

    state = JSON.parse(await readFile(paths.stateFile, "utf8"));
    assert.ok(state.rounds[0].completed_at);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("getRoundOutput requires agent_id when multiple outputs exist", async () => {
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
        artifacts: [],
        error: null,
      });
    }

    await assert.rejects(getRoundOutput({ data_dir: dataDir, review_session_id: "session-1", round: 1 }), /ambiguous/);
    const output = await getRoundOutput({
      data_dir: dataDir,
      review_session_id: "session-1",
      round: 1,
      agent_id: "codex-b",
    });
    assert.equal(output.content, "codex-b output");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects response_file outside artifact root", async () => {
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

    const responseFile = join(temp, "outside-response.json");
    await writeAdapterResponse(responseFile, {
      contract_version: 2,
      review_session_id: "session-1",
      agent_id: "codex",
      adapter: "codex",
      round: 1,
      status: "failed",
      output_file: null,
      artifacts: [],
      error: { message: "outside" },
    });

    await assert.rejects(completeRound({ data_dir: dataDir, response_file: responseFile }), /outside artifact root/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects non-integer round number", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    for (const bad of ["1", 0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        completeRoundFromEnvelope(dataDir, {
          contract_version: 2,
          review_session_id: "session-1",
          agent_id: "codex",
          adapter: "codex",
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    await assert.rejects(getRound({ data_dir: dataDir, review_session_id: "session-1", round: "1" }), /invalid round/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeRound rejects unsupported contract_version", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
        contract_version: 999,
        review_session_id: "session-1",
        agent_id: "codex",
        adapter: "codex",
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 2,
        review_session_id: "session-1",
        agent_id: "codex",
        adapter: "codex",
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
        contract_version: 2,
        review_session_id: "session-1",
        agent_id: "codex",
        adapter: "codex",
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });
    await prepareInitialRound({ data_dir: dataDir, review_session_id: "session-1" });

    await assert.rejects(
      completeRoundFromEnvelope(dataDir, {
        contract_version: 2,
        review_session_id: "session-1",
        agent_id: "codex",
        adapter: "codex",
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
        agent_id: "codex",
        adapter: "codex",
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
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
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
        contract_version: 2,
        review_session_id: "session-1",
        agent_id: "codex",
        adapter: "codex",
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
    await writeFile(outputFile, "review output", "utf8");

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
    await writeFile(outputFile, "review output", "utf8");

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
