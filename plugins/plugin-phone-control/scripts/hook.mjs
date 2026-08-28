#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dataPaths } from "../src/paths.mjs";
import { loadConfig } from "../src/config.mjs";
import { normalizeHookInput } from "../src/hook-normalizer.mjs";
import { postJson } from "../src/http-client.mjs";
import { appendSpool } from "../src/spool.mjs";
import { ensureStableHookRuntime } from "../src/hook-runtime.mjs";

function readStdin(limit = 1024 * 1024) {
  const input = readFileSync(0);
  if (input.length > limit) throw new Error("Hook input exceeds 1 MiB");
  return input.toString("utf8");
}

try {
  await ensureStableHookRuntime().catch(() => {});
  const input = JSON.parse(readStdin());
  const event = normalizeHookInput(input);
  if (event) {
    const config = await loadConfig();
    try {
      await postJson({
        port: config.port,
        token: config.token,
        path: "/api/internal/hook",
        body: event,
      });
      if (process.env.PHONE_CONTROL_DEBUG === "1") process.stderr.write("[phone-control hook] delivered\n");
    } catch (error) {
      if (process.env.PHONE_CONTROL_DEBUG === "1") process.stderr.write(`[phone-control hook] delivery failed: ${error.message}\n`);
      await appendSpool(dataPaths(config.dataDir).hookSpool, event);
      if (process.env.PHONE_CONTROL_DEBUG === "1") process.stderr.write("[phone-control hook] spooled\n");
    }
  } else if (process.env.PHONE_CONTROL_DEBUG === "1") {
    process.stderr.write("[phone-control hook] input was not a recognized hook event\n");
  }
} catch (error) {
  // Observability must never interrupt or alter the Codex task.
  if (process.env.PHONE_CONTROL_DEBUG === "1") process.stderr.write(`[phone-control hook] ${error.stack || error}\n`);
}
