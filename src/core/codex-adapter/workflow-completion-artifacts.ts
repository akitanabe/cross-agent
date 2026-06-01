import type { AdapterResponseArtifact } from "../shared/adapter-envelope.ts";
import { artifact, writeDiagnostic } from "./state.ts";
import type { ArtifactPathSet, CodexRunSpec } from "./types.ts";

export function completedArtifacts(runSpec: CodexRunSpec, paths: ArtifactPathSet): AdapterResponseArtifact[] {
  return [
    artifact(paths.runFile, "run_spec", runSpec.round, runSpec.agent_id),
    artifact(runSpec.output_file, "agent_output", runSpec.round, runSpec.agent_id),
    artifact(runSpec.event_log, "event_log", runSpec.round, runSpec.agent_id),
    artifact(runSpec.exit_file, "exit_status", runSpec.round, runSpec.agent_id),
  ];
}

export async function appendCompletionDiagnostic(
  runSpec: CodexRunSpec,
  paths: ArtifactPathSet,
  threadId: string,
  artifacts: AdapterResponseArtifact[],
): Promise<void> {
  if (!runSpec.warning && runSpec.decision_reason !== "target_root_changed") return;

  await writeDiagnostic(paths.diagnosticFile, [
    `# Codex adapter diagnostic`,
    ``,
    `- status: completed`,
    `- mode: ${runSpec.mode}`,
    runSpec.decision_reason ? `- decision_reason: ${runSpec.decision_reason}` : null,
    `- thread_id: ${threadId}`,
    runSpec.warning ? `- warning: ${runSpec.warning}` : null,
    runSpec.decision_reason === "target_root_changed" ? `- warning: target_root_changed` : null,
    runSpec.previous_thread_id ? `- previous_thread_id: ${runSpec.previous_thread_id}` : null,
    runSpec.previous_target_root ? `- previous_target_root: ${runSpec.previous_target_root}` : null,
    `- target_root: ${runSpec.target_root}`,
  ]);
  artifacts.push(artifact(paths.diagnosticFile, "diagnostic", runSpec.round, runSpec.agent_id));
}
