import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AdapterRequestInput, ArtifactPathSet, SessionState } from "./types.ts";
import { toDisplayPath } from "./workflow-common.ts";

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function buildClaudeContext({
  request,
  sessionState,
  currentPaths,
}: {
  request: AdapterRequestInput;
  sessionState: SessionState;
  currentPaths: ArtifactPathSet;
}): string {
  const targetFiles = uniqueStrings([...(request.target_files ?? []), ...(sessionState.context?.target_files ?? [])]);
  const priorRounds = (sessionState.rounds ?? [])
    .filter((round) => round.agent === "claude" && typeof round.round === "number" && round.round < request.round)
    .sort((left, right) => (left.round ?? 0) - (right.round ?? 0));

  const lines = [
    `# Claude adapter context`,
    ``,
    `## Session`,
    ``,
    `- review_session_id: ${request.review_session_id}`,
    `- target_root: ${toDisplayPath(request.target_root)}`,
    ``,
    `## References`,
    ``,
    `### Target files`,
    ``,
    ...(targetFiles.length ? targetFiles.map((file) => `- ${toDisplayPath(file)}`) : [`- none`]),
    ``,
    `## Required Reading`,
    ``,
    "`claude-agent` must read all files listed here before answering. If any file cannot be read, it must not infer",
    `the contents.`,
    ``,
    `### Prior rounds`,
    ``,
  ];

  if (priorRounds.length) {
    for (const round of priorRounds) {
      if (round.prompt_file) lines.push(`- prompt_file: ${toDisplayPath(round.prompt_file)}`);
      if (round.agent_result?.output_file) lines.push(`- output_file: ${toDisplayPath(round.agent_result.output_file)}`);
    }
  } else {
    lines.push(`- none`);
  }

  lines.push(``, `## Rounds`, ``);
  for (const round of priorRounds) {
    lines.push(`### Round ${round.round}: ${round.kind ?? "unknown"}`, ``);
    if (round.prompt_file) lines.push(`- prompt_file: ${toDisplayPath(round.prompt_file)}`);
    if (round.agent_result?.output_file) lines.push(`- output_file: ${toDisplayPath(round.agent_result.output_file)}`);
    lines.push(``);
  }

  lines.push(
    `### Round ${request.round}: ${request.round_kind}`,
    ``,
    `- prompt_file: ${toDisplayPath(request.prompt_file)}`,
    `- output_file: ${toDisplayPath(currentPaths.outputFile)}`,
    `- response_file: ${toDisplayPath(currentPaths.responseFile)}`,
    `- diagnostic_file: ${toDisplayPath(currentPaths.diagnosticFile)}`,
    ``,
  );

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

export function buildClaudeInput({
  request,
  contextFile,
  outputFile,
}: {
  request: AdapterRequestInput;
  contextFile: string;
  outputFile: string;
}): string {
  return `${[
    `# Claude adapter input`,
    ``,
    `## Current Round`,
    ``,
    `- prompt_file: ${toDisplayPath(request.prompt_file)}`,
    ``,
    `## Session Context`,
    ``,
    `- claude_context_file: ${toDisplayPath(contextFile)}`,
    ``,
    `Read this context file before answering. Then read all files listed in its Required Reading section.`,
    `If any required file cannot be read, do not infer its contents. Report failure through the adapter flow instead.`,
    ``,
    `## Request`,
    ``,
    `- review_session_id: ${request.review_session_id}`,
    `- round: ${request.round}`,
    `- round_kind: ${request.round_kind}`,
    `- target_root: ${toDisplayPath(request.target_root)}`,
    `- focus_question: ${request.focus_question ?? ""}`,
    ``,
    `## Output`,
    ``,
    `Write the final review body to:`,
    ``,
    `${toDisplayPath(outputFile)}`,
    ``,
  ].join("\n")}`;
}

export async function writeTextFile(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}
