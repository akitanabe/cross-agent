import { build } from "esbuild";

const entries = [
  ["src/runners/agent-review-runner.ts", "plugin/scripts/agent-review-runner.mjs"],
  ["src/runners/codex-adapter-runner.ts", "plugin/scripts/codex-adapter-runner.mjs"],
  ["src/runners/claude-adapter-runner.ts", "plugin/scripts/claude-adapter-runner.mjs"],
];

await Promise.all(
  entries.map(([entryPoint, outfile]) =>
    build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      packages: "external",
      logLevel: "info",
    }),
  ),
);
