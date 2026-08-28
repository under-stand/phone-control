#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const files = (await readdir(testDir)).filter((name) => name.endsWith(".test.mjs")).sort();
let failed = 0;
let passed = 0;

for (const file of files) {
  const module = await import(pathToFileURL(path.join(testDir, file)));
  for (const test of module.tests || []) {
    try {
      await test.run();
      passed += 1;
      process.stdout.write(`✓ ${test.name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`✗ ${test.name}\n${error.stack || error}\n`);
    }
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
