import { readFile, writeFile } from "node:fs/promises";

const versionInput = process.argv[2];
const semverPattern =
  /^v?(?<version>0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const match = versionInput?.match(semverPattern);
if (!match?.groups?.version) {
  console.error("Usage: npm run version:set -- <version>");
  console.error("Example: npm run version:set -- 1.1.0");
  process.exit(1);
}

const version = versionInput.replace(/^v/, "");
const tagVersion = `v${version}`;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function updateJson(path, update) {
  const value = await readJson(path);
  update(value);
  await writeJson(path, value);
}

await updateJson("package.json", (packageJson) => {
  packageJson.version = version;
});

await updateJson("package-lock.json", (packageLock) => {
  packageLock.version = version;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = version;
  }
});

await updateJson(".claude-plugin/marketplace.json", (marketplace) => {
  for (const plugin of marketplace.plugins ?? []) {
    if (plugin.name === "cross-agent") {
      plugin.version = version;
    }
  }
});

await updateJson("plugin/.claude-plugin/plugin.json", (pluginManifest) => {
  pluginManifest.version = version;
});

const readmePath = "README.md";
const readme = await readFile(readmePath, "utf8");
const readmeVersionPattern =
  /(\*\*ステータス\*\*: )v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

if (!readmeVersionPattern.test(readme)) {
  console.warn("README.md のステータス版数は更新対象が見つからなかったため、そのままです。");
} else {
  const nextReadme = readme.replace(readmeVersionPattern, (_, prefix) => `${prefix}${tagVersion}`);
  await writeFile(readmePath, nextReadme, "utf8");
}

console.log(`Updated project version to ${version}.`);
