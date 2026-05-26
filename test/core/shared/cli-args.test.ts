// @ts-nocheck
import { expect, test } from "vitest";
import assert from "node:assert/strict";

import {
  parseCommandArgs,
  parseIntegerOption,
  parseOptionArgs,
  requireOption,
} from "../../../src/core/shared/cli-args.ts";

test("parseIntegerOption parses safe integers", () => {
  assert.equal(parseIntegerOption("2", "--round"), 2);
  assert.equal(parseIntegerOption("0", "--round"), 0);
});

test("parseIntegerOption rejects non-integers", () => {
  assert.throws(() => parseIntegerOption("1.5", "--round"), /--round must be an integer/);
  assert.throws(() => parseIntegerOption("abc", "--round"), /--round must be an integer/);
});

test("requireOption returns present values and rejects missing values", () => {
  assert.equal(requireOption({ dataDir: "C:/data" }, "dataDir", "--data-dir"), "C:/data");
  assert.throws(() => requireOption({}, "dataDir", "--data-dir"), /--data-dir is required/);
  assert.throws(() => requireOption({ dataDir: "" }, "dataDir", "--data-dir"), /--data-dir is required/);
});

test("parseOptionArgs parses scalar and repeated multi-value options", () => {
  const args = parseOptionArgs(
    ["--data-dir", "C:/data", "--target-files", "src/a.ts", "src/b.ts", "--target-files", "src/c.ts"],
    {
      "--data-dir": { field: "dataDir" },
      "--target-files": { field: "targetFiles", multiple: true },
    },
  );

  assert.deepEqual(args, {
    dataDir: "C:/data",
    targetFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
  });
});

test("parseOptionArgs applies option parse callbacks", () => {
  const args = parseOptionArgs(["--round", "3"], {
    "--round": { field: "round", parse: parseIntegerOption },
  });

  assert.deepEqual(args, { round: 3 });
});

test("parseOptionArgs preserves parse callback return values", () => {
  const args = parseOptionArgs(["--launcher", ""], {
    "--launcher": { field: "launcher", parse: (value) => (value === "" ? null : value) },
  });

  assert.deepEqual(args, { launcher: null });
});

test("parseOptionArgs preserves initial args and supports help", () => {
  const args = parseOptionArgs(
    ["command", "--help"],
    {},
    {
      startIndex: 1,
      initialArgs: { command: "command" },
    },
  );

  assert.deepEqual(args, { command: "command", help: true });
});

test("parseOptionArgs rejects unknown, positional, and missing values", () => {
  assert.throws(() => parseOptionArgs(["--unknown"], {}), /Unknown argument: --unknown/);
  assert.throws(() => parseOptionArgs(["extra"], {}), /Unexpected positional argument: extra/);
  assert.throws(
    () => parseOptionArgs(["--data-dir"], { "--data-dir": { field: "dataDir" } }),
    /--data-dir requires a value/,
  );
  assert.throws(
    () => parseOptionArgs(["--target-files"], { "--target-files": { field: "targetFiles", multiple: true } }),
    /--target-files requires at least one value/,
  );
});

test("parseCommandArgs parses command-specific and common options", () => {
  const args = parseCommandArgs(["prepare", "--data-dir", "C:/data", "--round", "2"], {
    commonOptions: {
      "--data-dir": { field: "dataDir" },
    },
    commands: {
      prepare: {
        options: {
          "--round": { field: "round", parse: parseIntegerOption },
        },
      },
    },
  });

  assert.deepEqual(args, {
    command: "prepare",
    dataDir: "C:/data",
    round: 2,
  });
});

test("parseCommandArgs supports top-level help and rejects unknown commands", () => {
  assert.deepEqual(parseCommandArgs(["--help"], { commands: {} }), { command: null, help: true });
  assert.throws(() => parseCommandArgs(["missing"], { commands: {} }), /Unknown command: missing/);
});
