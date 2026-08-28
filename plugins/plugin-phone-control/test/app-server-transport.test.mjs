import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  appServerSpawnSpec,
  createAppServerTransport,
  probeAppServerCommand,
  spawnStdioAppServer,
} from "../src/app-server-transport.mjs";

function fakeChild({ onStart = null } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  queueMicrotask(() => {
    child.emit("spawn");
    onStart?.(child);
  });
  return child;
}

export const tests = [
  {
    name: "prefers the managed Unix socket when it is available",
    async run() {
      let spawned = false;
      const expected = { readable: new PassThrough(), writable: new PassThrough(), close() {} };
      const transport = await createAppServerTransport({
        socketPath: "/tmp/codex.sock",
        platform: "darwin",
        connectSocket: async (socketPath) => {
          assert.equal(socketPath, "/tmp/codex.sock");
          return expected;
        },
        spawnProcess() {
          spawned = true;
          return fakeChild();
        },
      });
      assert.equal(transport.kind, "managed-unix-websocket");
      assert.equal(transport.readable, expected.readable);
      assert.equal(spawned, false);
    },
  },
  {
    name: "falls back to a managed stdio app-server on macOS and Linux",
    async run() {
      const calls = [];
      const transport = await createAppServerTransport({
        socketPath: "/tmp/missing.sock",
        command: "/opt/codex/bin/codex",
        platform: "darwin",
        connectSocket: async () => { throw new Error("socket missing"); },
        spawnProcess(command, args, options) {
          calls.push({ command, args, options });
          return fakeChild();
        },
      });
      assert.equal(transport.kind, "managed-stdio");
      assert.equal(transport.fallbackReason, "socket missing");
      assert.equal(calls[0].command, "/opt/codex/bin/codex");
      assert.deepEqual(calls[0].args, ["app-server", "--listen", "stdio://"]);
      assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
      transport.close();
    },
  },
  {
    name: "launches npm codex.cmd through the Windows command processor",
    async run() {
      const environment = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };
      const spec = appServerSpawnSpec({
        command: "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd",
        platform: "win32",
        environment,
      });
      assert.equal(spec.command, environment.ComSpec);
      assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(spec.args[3], /^""C:\\Users\\Me\\AppData\\Roaming\\npm\\codex\.cmd"/);
      assert.match(spec.args[3], /"app-server" "--listen" "stdio:\/\/""$/);
    },
  },
  {
    name: "uses managed stdio directly on native Windows without probing a Unix socket",
    async run() {
      let socketAttempts = 0;
      const calls = [];
      const transport = await createAppServerTransport({
        command: "C:\\Tools\\codex.exe",
        platform: "win32",
        environment: { ComSpec: "cmd.exe" },
        connectSocket: async () => {
          socketAttempts += 1;
          throw new Error("must not run");
        },
        spawnProcess(command, args) {
          calls.push({ command, args });
          return fakeChild();
        },
      });
      assert.equal(transport.kind, "managed-stdio");
      assert.equal(socketAttempts, 0);
      assert.equal(calls[0].command, "C:\\Tools\\codex.exe");
      assert.deepEqual(calls[0].args, ["app-server", "--listen", "stdio://"]);
      transport.close();
    },
  },
  {
    name: "reports whether the configured Codex command advertises stdio app-server support",
    async run() {
      const supported = await probeAppServerCommand({
        command: "codex",
        platform: "linux",
        spawnProcess(command, args) {
          assert.equal(command, "codex");
          assert.deepEqual(args, ["app-server", "--help"]);
          return fakeChild({ onStart(child) {
            child.stdout.write("--listen <URL> stdio://\n");
            child.exitCode = 0;
            child.emit("close", 0, null);
          } });
        },
      });
      assert.deepEqual(supported, { available: true, reason: null });

      const unsupported = await probeAppServerCommand({
        command: "old-codex",
        platform: "linux",
        spawnProcess() {
          return fakeChild({ onStart(child) {
            child.stdout.write("legacy app server\n");
            child.exitCode = 0;
            child.emit("close", 0, null);
          } });
        },
      });
      assert.equal(unsupported.available, false);
      assert.match(unsupported.reason, /does not advertise/);

      const missing = await probeAppServerCommand({
        command: "missing-codex",
        spawnProcess() {
          throw new Error("executable not found");
        },
      });
      assert.deepEqual(missing, { available: false, reason: "executable not found" });
    },
  },
  {
    name: "closes a managed stdio child through stdin before forcing termination",
    async run() {
      let child;
      const transport = await spawnStdioAppServer({
        command: "codex",
        platform: "linux",
        spawnProcess() {
          child = fakeChild();
          return child;
        },
      });
      let ended = false;
      child.stdin.once("finish", () => { ended = true; });
      transport.close();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(ended, true);
    },
  },
];
