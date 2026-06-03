// @ts-nocheck

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { sessionPaths } from "../../../src/core/agent-review/state.ts";
import { commandOutput, readSession } from "../../../src/core/agent-review/workflow-common.ts";
import { startSession } from "../../../src/core/agent-review/workflow-session.ts";

test("commandOutput wraps typed content with output_type", () => {
  assert.deepEqual(commandOutput("json", { ok: true }), {
    output_type: "json",
    content: { ok: true },
  });
});

test("readSession loads matching state and paths", async () => {
  const temp = await mkdtemp(join(tmpdir(), "agent-review-"));
  try {
    const targetRoot = join(temp, "repo");
    const dataDir = join(temp, "data");
    await mkdir(targetRoot, { recursive: true });
    await startSession({ data_dir: dataDir, review_session_id: "session-1", target_root: targetRoot });

    const { paths, state } = await readSession(dataDir, "session-1");

    assert.deepEqual(paths, sessionPaths(dataDir, "session-1"));
    assert.equal(state.review_session_id, "session-1");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
