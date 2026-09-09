import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "src");
const outputDir = join(root, "dist");
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

for (const name of readdirSync(sourceDir)) {
  if (!name.endsWith(".ts")) continue;
  const source = readFileSync(join(sourceDir, name), "utf8");
  const output = stripTypeScriptTypes(source, { mode: "strip" })
    .replace(/((?:from\s*|import\s*\(\s*)["'])(\.\.?\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
  const target = join(outputDir, `${basename(name, ".ts")}.js`);
  writeFileSync(target, output);
  if (name === "cli.ts") chmodSync(target, 0o755);
}
