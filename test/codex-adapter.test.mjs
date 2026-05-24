import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 環境に bash があるかをテスト実行時に観測する。Windows なら Git Bash の bash.exe を想定。
function hasBashOnPath() {
  const result = spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
  return result.status === 0;
}

import {
  agentStateFileFor,
  artifactDirFor,
  artifactPaths,
  effortForReviewDepth,
  extractThreadIdFromJsonl,
  runAdapter,
  sessionStateFileFor,
  shouldStartNewSession,
  wrapWithLauncher,
} from "../scripts/codex-adapter-runner.mjs";

async function writeFakeCodex(temp) {
  const fakeCodex = join(temp, "fake-codex.mjs");
  await writeFile(
    fakeCodex,
    `import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
if (outputIndex === -1) {
  process.stderr.write("missing -o\\n");
  process.exit(2);
}

const outputFile = args[outputIndex + 1];
const mode = args[0] === "exec" && args[1] === "resume" ? "resume" : "initial";
const threadId = mode === "resume" ? args[outputIndex + 2] : "thread-abc";
const promptText = args[args.length - 1];
await writeFile(
  outputFile,
  \`mode:\${mode}\\nthread:\${threadId}\\nprompt:\${promptText}\\n\`,
  "utf8",
);

if (mode === "initial") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "thread.resumed", thread_id: threadId }) + "\\n");
}
`,
    "utf8",
  );
  return fakeCodex;
}

async function createRequestFixture(temp, { round = 1, prompt = "review this" } = {}) {
  const targetRoot = join(temp, "repo");
  const dataDir = join(temp, "data");
  const promptFile = join(temp, `prompt-${round}.md`);
  await mkdir(targetRoot, { recursive: true });
  await mkdir(join(dataDir, "sessions"), { recursive: true });
  await writeFile(promptFile, prompt, "utf8");
  await writeFile(
    sessionStateFileFor(dataDir, "session-1"),
    `${JSON.stringify({ review_session_id: "session-1" }, null, 2)}\n`,
    "utf8",
  );

  return {
    dataDir,
    targetRoot,
    request: {
      contract_version: 1,
      review_session_id: "session-1",
      agent: "codex",
      round,
      round_kind: round === 1 ? "initial_review" : "follow_up",
      target_root: targetRoot,
      prompt_file: promptFile,
      context_file: null,
      target_files: [],
      focus_question: null,
      options: { review_depth: "medium", timeout_seconds: null },
    },
  };
}

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

test("artifact path helpers use data directory layout", () => {
  const artifactDir = artifactDirFor("C:/data", "session-1");
  assert.match(artifactDir.replaceAll("\\", "/"), /C:\/data\/artifacts\/session-1$/);

  const sessionStateFile = sessionStateFileFor("C:/data", "session-1");
  assert.match(sessionStateFile.replaceAll("\\", "/"), /C:\/data\/sessions\/session-1\.json$/);

  const agentStateFile = agentStateFileFor("C:/data", "session-1");
  assert.match(agentStateFile.replaceAll("\\", "/"), /C:\/data\/sessions\/session-1\/agents\/codex\.json$/);

  const paths = artifactPaths(artifactDir, 2);
  assert.match(paths.outputFile.replaceAll("\\", "/"), /round-2-codex-output\.md$/);
  assert.match(paths.eventLog.replaceAll("\\", "/"), /round-2-codex-events\.jsonl$/);
  assert.match(paths.diagnosticFile.replaceAll("\\", "/"), /round-2-codex-diagnostic\.md$/);
  assert.match(paths.responseFile.replaceAll("\\", "/"), /round-2-codex-response\.json$/);
});

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

test(
  "runAdapter with launcher routes spawn through bash and preserves prompt with shell metacharacters",
  { skip: hasBashOnPath() ? false : "bash not on PATH" },
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

    // JSON 経由で stdin に流したときに parse 失敗しないことを確認する。
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
