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
  for (const [name, fields] of [
    ["ThreadQueueAddParams", ["threadId", "clientUserMessageId", "input"]],
    ["ThreadQueueListParams", ["threadId", "limit", "cursor"]],
    ["ThreadQueueDeleteParams", ["threadId", "queuedSubmissionId"]],
    ["ThreadTurnsListParams", ["threadId", "limit", "sortDirection", "itemsView"]],
  ]) {
    const schema = JSON.parse(await readFile(path.join(output, "v2", `${name}.json`), "utf8"));
    for (const field of fields) if (!schema.properties?.[field]) throw new Error(`${name} no longer exposes ${field}`);
  }
  const history = JSON.parse(await readFile(path.join(output, "v2", "ThreadTurnsListResponse.json"), "utf8"));
  const userMessage = history.definitions?.ThreadItem?.oneOf?.find((item) => item.properties?.type?.enum?.includes("userMessage"));
  if (!userMessage?.properties?.clientId) throw new Error("User message receipt no longer exposes clientId");
  process.stdout.write("Codex App Server schema exposes native CLI queue operations and correlated user-message receipts.\n");
} finally {
  await rm(output, { recursive: true, force: true });
}
