#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "artifacts", "coverage", "node_modules", "playwright-report", "test-results"]);
const sources = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name === "app.js" || entry.name === "sw.js")) sources.push(target);
  }
}

await visit(root);
for (const filePath of sources.sort()) {
  const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`${path.relative(root, filePath)}\n${result.stderr || result.stdout}`);
    process.exit(1);
  }
}

for (const filePath of ["package.json", ".codex-plugin/plugin.json"]) {
  JSON.parse(await readFile(path.join(root, filePath), "utf8"));
}

process.stdout.write(`Checked ${sources.length} JavaScript files and 2 manifests.\n`);
