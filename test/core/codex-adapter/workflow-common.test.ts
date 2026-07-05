// @ts-nocheck

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";

import { isObject, normalizeRequest, responsePath, runPath } from "../../../src/core/codex-adapter/workflow-common.ts";

test("isObject accepts plain objects only", () => {
  assert.equal(isObject({ ok: true }), true);
  assert.equal(isObject(null), false);
  assert.equal(isObject([]), false);
});

test("normalizeRequest and artifact paths use forward slashes", () => {
  const request = normalizeRequest({
    target_root: "C:\\repo",
    prompt_file: "C:\\repo\\prompt.md",
    context_file: "C:\\repo\\context.md",
    target_files: ["src\\a.ts"],
  });

  assert.equal(request.target_root, "C:/repo");
  assert.equal(request.prompt_file, "C:/repo/prompt.md");
  assert.equal(request.context_file, "C:/repo/context.md");
  assert.deepEqual(request.target_files, ["src/a.ts"]);
  assert.ok(!runPath({ runFile: join("C:\\tmp", "run.json") }).includes("\\"));
  assert.ok(!responsePath({ responseFile: join("C:\\tmp", "response.json") }).includes("\\"));
});
