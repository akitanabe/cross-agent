// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";

import { wrapWithLauncher } from "../../../src/core/codex-adapter/process.ts";

test("wrapWithLauncher passes through when launcher is missing", () => {
  assert.deepEqual(wrapWithLauncher(null, "codex", ["exec", "hi"]), {
    command: "codex",
    args: ["exec", "hi"],
  });
  assert.deepEqual(wrapWithLauncher("", "codex", ["exec", "hi"]), {
    command: "codex",
    args: ["exec", "hi"],
  });
});


test("wrapWithLauncher routes spawn through `launcher -c 'exec \"$@\"' launcher codex ...`", () => {
  // `-c 'exec "$@"' name ...` で shell の word splitting を bypass し、promptText を argv の
  // 1 要素として codex まで届ける契約。launcher が bash / sh / zsh いずれでも成立する。
  const wrapped = wrapWithLauncher("bash", "codex", ["exec", "prompt with $var"]);
  assert.equal(wrapped.command, "bash");
  assert.deepEqual(wrapped.args, ["-c", 'exec "$@"', "bash", "codex", "exec", "prompt with $var"]);
});


test("wrapWithLauncher normalizes only the launched command path", () => {
  const command = "C:\\tools\\codex.exe";
  const expectedCommand = process.platform === "win32" ? "C:/tools/codex.exe" : command;
  const wrapped = wrapWithLauncher("bash", command, ["exec", "prompt with C:\\raw\\text"]);

  assert.deepEqual(wrapped.args, ["-c", 'exec "$@"', "bash", expectedCommand, "exec", "prompt with C:\\raw\\text"]);
});
