// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";

import { parseArgs } from "../../../src/core/codex-adapter/cli.ts";

test("parseArgs uses shared option parser for codex adapter CLI options", () => {
  assert.deepEqual(parseArgs([]), {
    requestFile: null,
    codexBin: "codex",
    dataDir: null,
    launcher: null,
  });

  assert.deepEqual(
    parseArgs([
      "-r",
      "request.json",
      "--codex-bin",
      "codex-next",
      "--data-dir",
      "C:/data",
      "--launcher",
      "",
    ]),
    {
      requestFile: "request.json",
      codexBin: "codex-next",
      dataDir: "C:/data",
      launcher: null,
    },
  );

  assert.deepEqual(parseArgs(["--help"]), {
    requestFile: null,
    codexBin: "codex",
    dataDir: null,
    launcher: null,
    help: true,
  });
});


test("parseArgs rejects unknown codex adapter options and missing values", () => {
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument: --unknown/);
  assert.throws(() => parseArgs(["extra"]), /Unexpected positional argument: extra/);
  assert.throws(() => parseArgs(["--request"]), /--request requires a value/);
});
