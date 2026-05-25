// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentStateFileFor, artifactDirFor, artifactPaths } from "../../../src/core/codex-adapter/state.ts";
import { runAdapter } from "../../../src/core/codex-adapter/workflow.ts";
import { createRequestFixture, hasUsableBashLauncher, writeFakeCodex } from "../../helpers/codex-adapter-fixtures.ts";

test("runAdapter returns failed envelope when dataDir is missing (no env var fallback)", async () => {
  // 公式仕様 (plugins-reference) では ${CLAUDE_PLUGIN_DATA} は skill/agent content 内の
  // substitution であり Bash tool には env var として export されないため、--data-dir を
  // 唯一のソースとする。未指定なら invalid_request_envelope で fail-loud。
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { request } = await createRequestFixture(temp);
    const response = await runAdapter(request, { codexBin: process.execPath });
    assert.equal(response.status, "failed");
    assert.equal(response.error.code, "invalid_request_envelope");
    assert.match(response.error.message, /--data-dir is required/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("runAdapter starts a Codex session and persists thread mapping", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const fakeCodex = await writeFakeCodex(temp);
    const { dataDir, request } = await createRequestFixture(temp);

    const response = await runAdapter(request, {
      codexBin: process.execPath,
      codexBinArgs: [fakeCodex],
      dataDir,
    });

    assert.equal(response.status, "completed");
    assert.match(response.output_file, /round-1-codex-output\.md$/);

    const state = JSON.parse(await readFile(agentStateFileFor(dataDir, "session-1"), "utf8"));
    assert.equal(state.thread_id, "thread-abc");
    assert.equal(state.status, "active");
    assert.equal(state.last_error, null);

    const output = await readFile(response.output_file, "utf8");
    assert.match(output, /mode:initial/);

    const events = await readFile(artifactPaths(artifactDirFor(dataDir, "session-1"), 1).eventLog, "utf8");
    assert.match(events, /thread\.started/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test.skipIf(!hasUsableBashLauncher())(
  "runAdapter with launcher routes spawn through bash and preserves prompt with shell metacharacters",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
    try {
      const fakeCodex = await writeFakeCodex(temp);
      // promptText に $ や backtick が混ざっても word splitting されず argv で届くことを確認。
      const tricky = 'prompt with $VAR `cmd` "quote"';
      const { dataDir, request } = await createRequestFixture(temp, { prompt: tricky });

      const response = await runAdapter(request, {
        codexBin: process.execPath,
        codexBinArgs: [fakeCodex],
        dataDir,
        launcher: "bash",
      });

      assert.equal(response.status, "completed");
      const output = await readFile(response.output_file, "utf8");
      assert.match(output, /mode:initial/);
      assert.match(output, /thread:thread-abc/);
      // promptText が bash の word splitting / 変数展開を一切経由せず argv で届いていることを確認。
      assert.ok(output.includes(`prompt:${tricky}`), `expected prompt preserved, got: ${output}`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);


test("runAdapter response envelope path fields are forward-slash normalized", async () => {
  // adapter 境界の契約: cross-agent runner が `JSON.parse` する envelope に Windows の `\` が
  // 混ざると `\U` などの不正エスケープで落ちる。出力境界 (makeResponse) で normalize する。
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const fakeCodex = await writeFakeCodex(temp);
    const { dataDir, request } = await createRequestFixture(temp);

    const response = await runAdapter(request, {
      codexBin: process.execPath,
      codexBinArgs: [fakeCodex],
      dataDir,
    });

    assert.equal(response.status, "completed");
    assert.ok(!response.output_file.includes("\\"), `output_file has backslash: ${response.output_file}`);
    for (const entry of response.artifacts) {
      assert.ok(!entry.path.includes("\\"), `artifact path has backslash: ${entry.path}`);
    }

    // JSON として保存・再読込しても parse 失敗しないことを確認する。
    const serialized = JSON.stringify(response);
    assert.doesNotThrow(() => JSON.parse(serialized));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("runAdapter failure envelope normalizes error.details_file", async () => {
  // 失敗パスでも details_file が forward slash になることを確認する。
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const { dataDir, request } = await createRequestFixture(temp);
    // prompt_file を消して prompt_file_missing を誘発する。
    await rm(request.prompt_file);

    const response = await runAdapter(request, {
      codexBin: process.execPath,
      codexBinArgs: [],
      dataDir,
    });

    assert.equal(response.status, "failed");
    assert.equal(response.error.code, "prompt_file_missing");
    assert.ok(
      !response.error.details_file.includes("\\"),
      `error.details_file has backslash: ${response.error.details_file}`,
    );
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(response)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("runAdapter resumes an existing Codex session when target root matches", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  try {
    const fakeCodex = await writeFakeCodex(temp);
    const first = await createRequestFixture(temp, { round: 1 });
    await runAdapter(first.request, {
      codexBin: process.execPath,
      codexBinArgs: [fakeCodex],
      dataDir: first.dataDir,
    });

    const second = await createRequestFixture(temp, { round: 2, prompt: "follow up" });
    const response = await runAdapter(second.request, {
      codexBin: process.execPath,
      codexBinArgs: [fakeCodex],
      dataDir: second.dataDir,
    });

    assert.equal(response.status, "completed");
    const output = await readFile(response.output_file, "utf8");
    assert.match(output, /mode:resume/);
    assert.match(output, /thread:thread-abc/);

    const state = JSON.parse(await readFile(agentStateFileFor(second.dataDir, "session-1"), "utf8"));
    assert.equal(state.thread_id, "thread-abc");
    assert.equal(state.artifacts.filter((entry) => entry.kind === "agent_output").length, 2);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
