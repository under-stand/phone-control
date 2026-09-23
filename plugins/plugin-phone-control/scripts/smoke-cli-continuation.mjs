#!/usr/bin/env node
// Real, ordinary CLI TUI + independent App Server + mock model. No account,
// user conversation, production queue, or external model service is used.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { CodexAppServerBridge } from "../src/app-server-bridge.mjs";
import { spawnStdioAppServer } from "../src/app-server-transport.mjs";
import { CliSessionQueue } from "../src/cli-session-queue.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "phone-cli-smoke-"));
const codexHome = path.join(root, "codex");
await mkdir(codexHome);
const received = [];
const marker = "PHONE_NATIVE_QUEUE_SMOKE";
const mock = http.createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!request.url.includes("/responses")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  received.push(JSON.parse(raw));
  const id = `resp_${received.length}`;
  const item = { type: "message", id: `msg_${received.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "SMOKE_OK", annotations: [] }] };
  const reply = { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { ...reply, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "SMOKE_OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: reply },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const overrides = [
  'model="test-model"', 'model_provider="probe"',
  'model_providers.probe.name="Probe"',
  `model_providers.probe.base_url="http://127.0.0.1:${mock.address().port}/v1"`,
  'model_providers.probe.wire_api="responses"', 'model_providers.probe.requires_openai_auth=false',
  'approval_policy="never"', 'sandbox_mode="read-only"', 'features.plugins=false',
  `projects.${JSON.stringify(root)}.trust_level="trusted"`,
];
const environment = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color", COLUMNS: "100", LINES: "32", OPENAI_API_KEY: "synthetic-test-key" };
const codex = process.env.CODEX_COMMAND || "codex";
const args = [codex, "--no-alt-screen", "-C", root, ...overrides.flatMap((value) => ["-c", value]), "CLI_WARMUP"];
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const tui = spawn("script", ["-q", "-c", `stty rows 32 cols 100; exec ${args.map(quote).join(" ")}`, "/dev/null"], {
  env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true,
});
let output = "";
let spawnError = false;
tui.on("error", () => { spawnError = true; });
tui.stdin.on("error", () => {});
tui.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output = (output + stripVTControlCharacters(text)).slice(-12000);
  for (const [query, reply] of [
    ["\x1b[6n", "\x1b[1;1R"], ["\x1b]10;?", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"],
    ["\x1b]11;?", "\x1b]11;rgb:0000/0000/0000\x1b\\"], ["\x1b[?u", "\x1b[?0u"], ["\x1b[c", "\x1b[?1;2c"],
  ]) if (text.includes(query)) tui.stdin.write(reply);
});
tui.stderr.on("data", () => {});
let trusted = false;
let trustDelay;
const trustTimer = setInterval(() => {
  if (!trusted && /Press enter to continue/.test(output)) {
    trusted = true;
    trustDelay = setTimeout(() => tui.stdin.write("\r"), 500);
  }
}, 100);
const bridge = new CodexAppServerBridge({
  reconnect: false, loadedThreadRefreshMs: 0, shouldAutoResumeLoadedThread: () => false,
  transportFactory: () => spawnStdioAppServer({ codexCommand: codex, environment,
    spawnProcess: (command, argv, options) => spawn(command, [...argv, ...overrides.flatMap((value) => ["-c", value])], { ...options, cwd: root }),
  }),
});
bridge.on("warning", () => {});
async function waitUntil(check) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error("Unable to start isolated CLI; this smoke requires Linux script/stty");
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated CLI condition timed out");
}
const queue = new CliSessionQueue({ bridge, filePath: path.join(root, "journal.json") });
try {
  // Let the CLI initialize its new database before launching the other process.
  await waitUntil(() => received.length > 0);
  await bridge.start();
  let threadId;
  await waitUntil(async () => {
    threadId = (await bridge.request("thread/list", { limit: 10 })).data?.[0]?.id;
    return Boolean(threadId);
  });
  const request = bridge.request.bind(bridge);
  bridge.request = (method, params) => {
    assert.ok(!["thread/resume", "thread/queue/start", "turn/start", "turn/steer"].includes(method), "Phone must not acquire the CLI writer");
    return request(method, params);
  };
  const input = { sessionId: threadId, deviceId: "synthetic-phone", clientMessageId: "smoke-message-0001", text: marker };
  assert.equal((await queue.submit(input)).status, "cli_queued");
  await queue.submit(input);
  await waitUntil(() => received.some((item) => JSON.stringify(item.input).includes(marker)));
  await waitUntil(async () => {
    await queue.reconcile();
    return queue.list({ includeTerminal: true })[0]?.outcome === "completed";
  });
  assert.equal(queue.list({ includeTerminal: true })[0].sessionId, threadId);
  assert.equal((await request("thread/queue/list", { threadId })).data.length, 0);
  const turns = await request("thread/turns/list", { threadId, limit: 20, sortDirection: "desc", itemsView: "full" });
  assert.equal(turns.data.filter((turn) => turn.items.some((item) => item.type === "userMessage" && JSON.stringify(item.content).includes(marker))).length, 1);
  console.log("PASS: original CLI continued the same thread, one message/turn, verified completion, no writer takeover.");
} catch {
  process.stderr.write("FAIL: isolated CLI continuation smoke did not complete; no production session was touched.\n");
  process.exitCode = 1;
} finally {
  clearInterval(trustTimer);
  clearTimeout(trustDelay);
  await queue.flush();
  await bridge.close();
  try { process.kill(-tui.pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => mock.close(resolve));
  await rm(root, { recursive: true, force: true });
}
