// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareClaudeRun } from "../../../src/core/claude-adapter/workflow-prepare.ts";
import { completeClaudeRun } from "../../../src/core/claude-adapter/workflow-complete.ts";
import { createClaudeRequestFixture } from "../../helpers/claude-adapter-fixtures.ts";

test("completeClaudeRun writes completed response", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);
    const prepared = await prepareClaudeRun(request, { dataDir });
    await writeFile(prepared.output_file, "review body\n", "utf8");

    const completed = await completeClaudeRun(request, prepared.output_file, { dataDir });
    assert.match(completed.path, /round-1-claude-response\.json$/);
    assert.equal(completed.response.status, "completed");
    assert.match(completed.response.output_file, /round-1-claude-output\.md$/);

    const savedResponse = JSON.parse(await readFile(completed.path, "utf8"));
    assert.equal(savedResponse.status, "completed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("completeClaudeRun fails when output is missing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  try {
    const { dataDir, request } = await createClaudeRequestFixture(temp);
    const prepared = await prepareClaudeRun(request, { dataDir });

    const completed = await completeClaudeRun(request, prepared.output_file, { dataDir });
    assert.equal(completed.response.status, "failed");
    assert.equal(completed.response.error.code, "claude_output_missing");
    assert.equal(completed.response.output_file, null);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
