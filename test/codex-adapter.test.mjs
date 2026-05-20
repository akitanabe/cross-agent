import test from "node:test";
import assert from "node:assert/strict";

import {
  artifactDirFor,
  artifactPaths,
  effortForReviewDepth,
  extractThreadIdFromJsonl,
  shouldStartNewSession,
} from "../scripts/codex-adapter.mjs";

test("effortForReviewDepth maps abstract depth to Codex effort", () => {
  assert.deepEqual(effortForReviewDepth("low"), { effort: "medium", warning: null });
  assert.deepEqual(effortForReviewDepth("medium"), { effort: "high", warning: null });
  assert.deepEqual(effortForReviewDepth("high"), { effort: "xhigh", warning: null });
  assert.equal(effortForReviewDepth("surprise").effort, "high");
  assert.match(effortForReviewDepth("surprise").warning, /Unknown review_depth/);
});

test("extractThreadIdFromJsonl ignores non-json lines and returns thread.started id", () => {
  const text = [
    "stderr noise",
    JSON.stringify({ type: "other.event", thread_id: "wrong" }),
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
  ].join("\n");

  assert.equal(extractThreadIdFromJsonl(text), "thread-123");
});

test("extractThreadIdFromJsonl returns null when no thread id exists", () => {
  assert.equal(extractThreadIdFromJsonl('{"type":"other.event"}\nnot json'), null);
});

test("shouldStartNewSession starts when thread id is missing", () => {
  assert.deepEqual(shouldStartNewSession({}, "C:/repo"), {
    startNew: true,
    reason: "missing_thread_id",
  });
});

test("shouldStartNewSession starts when target root changed", () => {
  assert.deepEqual(shouldStartNewSession({ thread_id: "t1", target_root: "C:/old" }, "C:/new"), {
    startNew: true,
    reason: "target_root_changed",
  });
});

test("shouldStartNewSession resumes when thread id and target root match", () => {
  assert.deepEqual(shouldStartNewSession({ thread_id: "t1", target_root: "C:/repo" }, "C:/repo"), {
    startNew: false,
    reason: "resume",
  });
});

test("artifact path helpers use state file sibling data layout", () => {
  const artifactDir = artifactDirFor("C:/data/sessions/session-1.json", "session-1");
  assert.match(artifactDir.replaceAll("\\", "/"), /C:\/data\/artifacts\/session-1$/);

  const paths = artifactPaths(artifactDir, 2);
  assert.match(paths.outputFile.replaceAll("\\", "/"), /round-2-codex-output\.md$/);
  assert.match(paths.eventLog.replaceAll("\\", "/"), /round-2-codex-events\.jsonl$/);
  assert.match(paths.diagnosticFile.replaceAll("\\", "/"), /round-2-codex-diagnostic\.md$/);
  assert.match(paths.responseFile.replaceAll("\\", "/"), /round-2-codex-response\.json$/);
});
