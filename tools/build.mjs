import { build } from "esbuild";

const entries = [
  ["src/runners/cross-agent-runner.ts", "scripts/cross-agent-runner.mjs"],
  ["src/runners/codex-adapter-runner.ts", "scripts/codex-adapter-runner.mjs"],
  ["src/runners/utils-runner.ts", "scripts/utils-runner.mjs"],
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
