// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";

import { buildAdapterRequest } from "../../../src/core/cross-agent/envelope.ts";
import { normalizeOptions } from "../../../src/core/cross-agent/state.ts";

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
