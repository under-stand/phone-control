#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dataPaths } from "../src/paths.mjs";
import { loadConfig } from "../src/config.mjs";
import { normalizeHookInput } from "../src/hook-normalizer.mjs";
import { requestJson } from "../src/http-client.mjs";
import { appendSpool } from "../src/spool.mjs";
import { ensureStableHookRuntime } from "../src/hook-runtime.mjs";

function readStdin(limit = 1024 * 1024) {
  const input = readFileSync(0);
  if (input.length > limit) throw new Error("Hook input exceeds 1 MiB");
  return input.toString("utf8");
}

function hookDecision(decision) {
  if (decision === "allow") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    };
  }
  if (decision === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied from Phone Control" },
      },
    };
  }
  return null;
}

try {
  await ensureStableHookRuntime().catch(() => {});
  const input = JSON.parse(readStdin());
  const event = normalizeHookInput(input);
  if (event?.kind === "permission_request") {
    const config = await loadConfig();
    try {
      const created = await requestJson({
        port: config.port,
        token: config.token,
        path: "/api/internal/approvals",
        method: "POST",
        body: { event },
        timeoutMs: 750,
      });
      if (created.body?.enabled && created.body.approval?.id) {
        const result = await requestJson({
          port: config.port,
          token: config.token,
          path: `/api/internal/approvals/${encodeURIComponent(created.body.approval.id)}`,
          timeoutMs: (config.approvals?.timeoutSeconds || 45) * 1_000 + 3_000,
        });
        const output = hookDecision(result.body?.approval?.decision);
        if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
      }
    } catch {
      await appendSpool(dataPaths(config.dataDir).hookSpool, event);
    }
  }
} catch (error) {
  // Any failure declines to decide so Codex falls back to its normal approval UI.
  if (process.env.PHONE_CONTROL_DEBUG === "1") process.stderr.write(`[phone-control permission hook] ${error.stack || error}\n`);
}
