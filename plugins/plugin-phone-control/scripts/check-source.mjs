#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHONE_CONTROL_ASSET_VERSION, PHONE_CONTROL_VERSION } from "../src/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "artifacts", "coverage", "node_modules", "playwright-report", "test-results"]);
const sources = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) sources.push(target);
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

const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const pluginManifest = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
if (packageManifest.version !== PHONE_CONTROL_VERSION) {
  throw new Error(`package.json version ${packageManifest.version} does not match runtime ${PHONE_CONTROL_VERSION}`);
}
if (typeof pluginManifest.version !== "string" || !pluginManifest.version.startsWith(`${PHONE_CONTROL_VERSION}+`)) {
  throw new Error(`.codex-plugin/plugin.json version ${pluginManifest.version} does not match runtime ${PHONE_CONTROL_VERSION}`);
}
const repositoryUrl = packageManifest.repository?.url;
const publicRepository = "git+https://github.com/under-stand/phone-control.git";
if (repositoryUrl !== publicRepository) {
  throw new Error("public package.json repository must point to under-stand/phone-control");
}
if (packageManifest.repository?.directory !== "plugins/plugin-phone-control") {
  throw new Error("public monorepo package.json must declare directory plugins/plugin-phone-control");
}
const escapedRuntimeVersion = PHONE_CONTROL_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^${escapedRuntimeVersion}\\+codex\\.\\d{14}$`).test(pluginManifest.version)) {
  throw new Error(`.codex-plugin/plugin.json version ${pluginManifest.version} is missing a cachebuster timestamp`);
}

const installer = await readFile(path.join(root, "install-windows.ps1"), "utf8");
if (!installer.includes("https://github.com/under-stand/phone-control.git")) {
  throw new Error("Windows installer must clone the public phone-control repository");
}
if (!installer.includes("plugins\\plugin-phone-control") || !installer.includes("$sourceRoot")) {
  throw new Error("Windows installer must preserve the public monorepo plugin path");
}

const staticAssets = [
  "public/index.html",
  "public/browser.html",
  "public/app.js",
  "public/browser.js",
  "public/sw.js",
];
const assetVersions = new Set();
for (const filePath of staticAssets) {
  const contents = await readFile(path.join(root, filePath), "utf8");
  for (const match of contents.matchAll(/(?:[?&]v=|phone-control-v)(\d+)/g)) assetVersions.add(Number(match[1]));
}
if (assetVersions.size !== 1 || !assetVersions.has(PHONE_CONTROL_ASSET_VERSION)) {
  throw new Error(`Static frontend assets are not consistently versioned at v${PHONE_CONTROL_ASSET_VERSION}: ${[...assetVersions].join(", ") || "none"}`);
}

process.stdout.write(`Checked ${sources.length} JavaScript files, 2 manifests and frontend assets v${PHONE_CONTROL_ASSET_VERSION}.\n`);
