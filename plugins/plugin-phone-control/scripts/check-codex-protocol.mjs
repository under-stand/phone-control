#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { codexPermissionSelection } from "../src/codex-permissions.mjs";

const run = promisify(execFile);
const codexCommand = process.env.CODEX_COMMAND || "codex";
const output = await mkdtemp(path.join(os.tmpdir(), "phone-control-codex-schema-"));

try {
  await run(codexCommand, ["app-server", "generate-json-schema", "--experimental", "--out", output], {
    windowsHide: true,
    timeout: 15_000,
  });
  const schemas = await Promise.all(["ThreadStartParams.json", "TurnStartParams.json"].map(async (name) => {
    const body = await readFile(path.join(output, "v2", name), "utf8");
    return { name, schema: JSON.parse(body) };
  }));
  const emittedPolicy = codexPermissionSelection("on-request", process.cwd()).approvalPolicy;
  for (const { name, schema } of schemas) {
    const values = schema.definitions?.AskForApproval?.oneOf
      ?.flatMap((option) => Array.isArray(option.enum) ? option.enum : []) || [];
    if (!values.includes(emittedPolicy)) {
      throw new Error(`${name} does not accept Phone Control approvalPolicy ${JSON.stringify(emittedPolicy)}; accepted values: ${values.join(", ") || "unknown"}`);
    }
    if (!schema.properties?.approvalPolicy) throw new Error(`${name} no longer exposes approvalPolicy`);
  }
  process.stdout.write(`Codex App Server schema accepts approvalPolicy ${JSON.stringify(emittedPolicy)} for thread/start and turn/start.\n`);
} finally {
  await rm(output, { recursive: true, force: true });
}
