// @ts-nocheck

import assert from "node:assert/strict";
import { test } from "vitest";

import { parseArgs } from "../../../src/core/codex-adapter/cli.ts";

test("parseArgs parses codex adapter prepare command", () => {
  assert.deepEqual(parseArgs([]), {
    command: null,
    requestFile: null,
    dataDir: null,
    runFile: null,
    help: undefined,
  });

  assert.deepEqual(parseArgs(["prepare", "--data-dir", "C:/data", "-r", "request.json"]), {
    command: "prepare",
    requestFile: "request.json",
    dataDir: "C:/data",
    runFile: null,
    help: undefined,
  });

  assert.deepEqual(parseArgs(["--help"]), {
    command: null,
    requestFile: null,
    dataDir: null,
    runFile: null,
    help: true,
  });
});

test("parseArgs parses codex adapter complete command", () => {
  assert.deepEqual(parseArgs(["complete", "--data-dir", "C:/data", "--run", "run.json"]), {
    command: "complete",
    requestFile: null,
    dataDir: "C:/data",
    runFile: "run.json",
    help: undefined,
  });
});

test("parseArgs rejects unknown codex adapter commands/options and missing values", () => {
  assert.throws(() => parseArgs(["unknown"]), /Unknown command: unknown/);
  assert.throws(() => parseArgs(["prepare", "--unknown"]), /Unknown argument: --unknown/);
  assert.throws(() => parseArgs(["prepare", "--request"]), /--request requires a value/);
  assert.throws(() => parseArgs(["prepare", "extra"]), /Unexpected positional argument: extra/);
});
