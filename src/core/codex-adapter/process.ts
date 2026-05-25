import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizePath } from "../shared/path-utils.ts";
import type {
  AdapterRequestInput,
  CodexCommandResult,
  CodexEffort,
  LaunchTarget,
} from "./types.ts";

// launcher が指定されたとき、spawn の command/args を「launcher -c 'exec "$@"' launcher <codex...>」
// 形式に組み直す。POSIX shell の `-c '...' name args` 規約に従い、`exec "$@"` で shell の word
// splitting / 変数展開を完全に bypass する。これにより promptText に `$` などが含まれても
// argv の 1 要素として codex まで届く。launcher は bash / sh / zsh など POSIX shell を想定し、
// 環境差異 (Windows の .cmd shim 等) は agent が --launcher で渡したシェルが解決する。
export function wrapWithLauncher(launcher: string | null | undefined, command: string, extraArgs: string[]): LaunchTarget {
  if (!launcher) return { command, args: extraArgs };
  const launcherCommand = normalizePath(command);
  return {
    command: launcher,
    args: ["-c", 'exec "$@"', launcher, launcherCommand, ...extraArgs],
  };
}

// Codex CLI を initial/resume のどちらかの mode で実行し、event log を保存する。
export async function runCodex({
  codexBin,
  codexBinArgs = [],
  launcher,
  mode,
  request,
  promptText,
  effort,
  outputFile,
  eventLog,
  threadId,
}: {
  codexBin: string;
  codexBinArgs?: string[];
  launcher: string | null;
  mode: "initial" | "resume";
  request: AdapterRequestInput;
  promptText: string;
  effort: CodexEffort;
  outputFile: string;
  eventLog: string;
  threadId: string | null;
}): Promise<CodexCommandResult> {
  // prompt は shell 展開を通さず、argv の 1 要素として渡す。
  const args: string[] =
    mode === "initial"
      ? [
          "exec",
          "-C",
          request.target_root,
          "--json",
          "--skip-git-repo-check",
          "-c",
          `model_reasoning_effort=${effort}`,
          "-o",
          outputFile,
          promptText,
        ]
      : [
          "exec",
          "resume",
          "--skip-git-repo-check",
          "-c",
          `model_reasoning_effort=${effort}`,
          "-o",
          outputFile,
          threadId ?? "",
          promptText,
        ];

  await mkdir(dirname(eventLog), { recursive: true });

  const target = wrapWithLauncher(launcher, codexBin, [...codexBinArgs, ...args]);

  return await new Promise<CodexCommandResult>((resolvePromise) => {
    const eventStream = createWriteStream(eventLog, { flags: "w" });
    // CLI trace を 1 つの診断 artifact に残すため、stderr も stdout と同じ log に保存する。
    const child = spawn(target.command, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.pipe(eventStream, { end: false });
    child.stderr.pipe(eventStream, { end: false });

    child.on("error", (error) => {
      eventStream.end(() => {
        resolvePromise({ code: null, signal: null, error, args });
      });
    });

    child.on("close", (code, signal) => {
      eventStream.end(() => {
        resolvePromise({ code, signal, error: null, args });
      });
    });
  });
}
