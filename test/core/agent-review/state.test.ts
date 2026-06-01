// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";

import { normalizeOptions, sessionPaths } from "../../../src/core/agent-review/state.ts";

test("normalizeOptions fills defaults", () => {
  assert.deepEqual(normalizeOptions({ review_depth: "high" }), {
    auto_deep_dive: true,
    review_depth: "high",
    keep_artifacts: false,
  });
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
