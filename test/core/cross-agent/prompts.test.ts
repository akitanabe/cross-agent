// @ts-nocheck
import { test } from "vitest";
import assert from "node:assert/strict";

import { buildInitialPrompt, buildNextRoundPrompt } from "../../../src/core/cross-agent/prompts.ts";

test("buildInitialPrompt includes focus, context, target files, and review viewpoints", () => {
  const prompt = buildInitialPrompt({
    focusQuestion: "この設計でよいか",
    contextFile: "C:/data/context.md",
    targetFiles: ["src/a.ts", "src/b.ts"],
  });

  assert.match(prompt, /この設計でよいか/);
  assert.match(prompt, /C:\/data\/context\.md/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /見落としているリスク/);
});


test("buildNextRoundPrompt includes previous output, focus, and follow-up directions", () => {
  const prompt = buildNextRoundPrompt({
    promptText: "根拠が弱い指摘を検証して",
    previousOutputFile: "C:/data/round-1-output.md",
    focusQuestion: "この設計でよいか",
  });

  assert.match(prompt, /同じレビューセッションを継続/);
  assert.match(prompt, /C:\/data\/round-1-output\.md/);
  assert.match(prompt, /根拠が弱い指摘を検証して/);
  assert.match(prompt, /確信度が上がった点/);
});
