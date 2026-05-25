// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequestFixture } from "../helpers/codex-adapter-fixtures.ts";

const runnerPath = fileURLToPath(new URL("../../scripts/codex-adapter-runner.mjs", import.meta.url));

test("codex adapter CLI reads request file and writes response file path to stdout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    await rm(request.prompt_file);
    const requestFile = join(temp, "request-envelope.json");
    await writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        runnerPath,
        "--data-dir",
        dataDir,
        "--request",
        requestFile,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    assert.equal(result.status, 1, result.stderr);
    const responseFile = result.stdout.trim();
    assert.match(responseFile, /round-1-codex-response\.json$/);
    const response = JSON.parse(await readFile(responseFile, "utf8"));
    assert.equal(response.status, "failed");
    assert.equal(response.error.code, "prompt_file_missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
