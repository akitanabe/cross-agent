import { parseOptionArgs } from "./cli-args.ts";
import type { ParsedCodexAdapterArgs } from "./codex-adapter-types.ts";

const optionArgs = {
  "--request": { field: "requestFile" },
  "-r": { field: "requestFile" },
  "--codex-bin": { field: "codexBin" },
  "--data-dir": { field: "dataDir" },
  "--launcher": {
    field: "launcher",
    // codex 起動を POSIX shell 経由で wrap する。空文字なら未指定扱い (直接 spawn) にする。
    parse: (value: string) => (value === "" ? null : value),
  },
};

// CLI 引数を、この runner が扱う option に変換する。
export function parseArgs(argv: string[]): ParsedCodexAdapterArgs {
  return parseOptionArgs(argv, optionArgs, {
    initialArgs: {
      requestFile: null,
      codexBin: "codex",
      dataDir: null,
      launcher: null,
    },
  }) as ParsedCodexAdapterArgs;
}

// CLI の使い方テキストを返す。
export function usage(): string {
  return `Usage:
  node scripts/codex-adapter-runner.mjs --request <request-envelope.json> [--codex-bin codex] [--data-dir <CLAUDE_PLUGIN_DATA>] [--launcher <shell>]

Reads a cross-agent adapter request envelope, executes Codex CLI, updates state JSON,
and writes the adapter response envelope to the artifact directory. stdout contains only
the response envelope file path.

--launcher wraps codex via a POSIX shell (e.g. \`--launcher bash\`). Use this when the
codex binary on the current platform is a shell shim that cannot be spawned directly,
e.g. on Windows where codex is a Git Bash script. The agent decides per-platform whether
to pass --launcher; the runner has no platform branch.`;
}
