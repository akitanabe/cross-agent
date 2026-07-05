// @ts-nocheck

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  agentContextFileFor,
  artifactDirFor,
  artifactPaths,
  validateRequest,
} from "../../../src/core/claude-adapter/state.ts";
import { ClaudePrepareFailedError } from "../../../src/core/claude-adapter/workflow-failure.ts";
import { prepareClaudeRun } from "../../../src/core/claude-adapter/workflow-prepare.ts";
import { createClaudeRequestFixture } from "../../helpers/claude-adapter-fixtures.ts";

test("prepareClaudeRun writes input and context files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);

    const prepared = await prepareClaudeRun(request, { dataDir });
    assert.equal(prepared.kind, "input");
    assert.match(prepared.path, /round-1-claude-input\.md$/);
    assert.match(prepared.output_file, /round-1-claude-output\.md$/);

    const input = await readFile(prepared.path, "utf8");
    assert.match(input, /claude_context_file:/);
    assert.match(input, /round-1-claude-output\.md/);

    const context = await readFile(agentContextFileFor(dataDir, request.review_session_id), "utf8");
    assert.match(context, /# Claude adapter context/);
    assert.match(context, /Round 1: initial_review/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("validateRequest rejects round that is not a positive safe integer", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { request } = await createClaudeRequestFixture(temp);
    for (const round of [0, -1, 1.5, "1", "../escape", Number.NaN]) {
      const error = await validateRequest({ ...request, round });
      assert.equal(error?.code, "invalid_request_envelope", `expected rejection for round ${round}`);
      assert.match(error?.message, /round/);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareClaudeRun keeps a malicious round out of artifact paths", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);

    let caught: ClaudePrepareFailedError | null = null;
    await assert.rejects(
      async () => {
        await prepareClaudeRun({ ...request, round: "../../escape" }, { dataDir });
      },
      (error) => {
        caught = error as ClaudePrepareFailedError;
        return error instanceof ClaudePrepareFailedError;
      },
    );

    assert.equal(caught?.response.error.code, "invalid_request_envelope");
    assert.match(caught?.response.error.message, /round/);
    assert.match(caught?.path, /round-unknown-claude-response\.json$/);
    assert.ok(!caught?.path.includes(".."), `path contains traversal: ${caught?.path}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareClaudeRun writes failed response then rejects", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);
    await rm(request.prompt_file);
    const paths = artifactPaths(artifactDirFor(dataDir, request.review_session_id), request.round);

    let caught: ClaudePrepareFailedError | null = null;
    await assert.rejects(
      async () => {
        await prepareClaudeRun(request, { dataDir });
      },
      (error) => {
        caught = error as ClaudePrepareFailedError;
        return error instanceof ClaudePrepareFailedError;
      },
    );

    assert.equal(caught?.path, paths.responseFile.replaceAll("\\", "/"));
    assert.equal(caught?.response.status, "failed");
    assert.equal(caught?.response.error.code, "prompt_file_missing");
    const savedResponse = JSON.parse(await readFile(paths.responseFile, "utf8"));
    assert.equal(savedResponse.status, "failed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepareClaudeRun separates artifacts and context by agent_id", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp, { agentId: "claude-reviewer" });

    const prepared = await prepareClaudeRun(request, { dataDir });
    assert.match(prepared.path, /round-1-claude-reviewer-input\.md$/);
    assert.match(prepared.output_file, /round-1-claude-reviewer-output\.md$/);

    const contextFile = agentContextFileFor(dataDir, request.review_session_id, "claude-reviewer");
    const context = await readFile(contextFile, "utf8");
    assert.match(context, /# Claude adapter context/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
