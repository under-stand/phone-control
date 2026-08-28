import { spawn } from "node:child_process";
import { connectUnixWebSocket } from "./unix-websocket.mjs";

const START_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_BYTES = 256 * 1024;
const TRANSPORT_MODES = new Set(["auto", "socket", "stdio"]);

function normalizedCommand(value) {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command || command.length > 4_096 || /[\r\n\0]/.test(command)) {
    throw new Error("Codex executable is invalid");
  }
  return command;
}

export function normalizeAppServerTransportMode(value, fallback = "auto") {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TRANSPORT_MODES.has(mode) ? mode : fallback;
}

function windowsCommandLine(command, args) {
  // The Windows installer can resolve either codex.exe or npm's codex.cmd.
  // cmd.exe is required for the latter. Windows paths cannot contain a quote;
  // wrap the complete /c payload as well as each fixed argument so paths with
  // spaces or shell metacharacters remain a single executable token.
  if (command.includes('"')) throw new Error("Codex executable contains an unsupported quote");
  const inner = [`"${command}"`, ...args.map((argument) => `"${String(argument).replaceAll('"', '""')}"`)].join(" ");
  return `"${inner}"`;
}

export function appServerSpawnSpec({
  command = "codex",
  args = ["app-server", "--listen", "stdio://"],
  platform = process.platform,
  environment = process.env,
} = {}) {
  const executable = normalizedCommand(command);
  if (platform !== "win32") return { command: executable, args: [...args] };
  if (/\.exe$/i.test(executable)) return { command: executable, args: [...args] };
  return {
    command: environment.ComSpec || environment.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", windowsCommandLine(executable, args)],
  };
}

function createClosedPromise(child) {
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  let settled = false;
  const settle = (details) => {
    if (settled) return;
    settled = true;
    finish(details);
  };
  child.once("error", (error) => settle({ error }));
  child.once("close", (code, signal) => settle({ code, signal }));
  return closed;
}

export function spawnStdioAppServer({
  command = "codex",
  platform = process.platform,
  environment = process.env,
  spawnProcess = spawn,
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  const spec = appServerSpawnSpec({ command, platform, environment });
  const child = spawnProcess(spec.command, spec.args, {
    env: environment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = createClosedPromise(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error("Timed out starting the managed Codex app-server"));
    }, startTimeoutMs);
    timer.unref?.();

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start the managed Codex app-server: ${error.message}`));
    };
    child.once("error", fail);
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", fail);
      let closing = false;
      resolve({
        kind: "managed-stdio",
        readable: child.stdout,
        writable: child.stdin,
        stderr: child.stderr,
        closed,
        pid: child.pid || null,
        close() {
          if (closing) return;
          closing = true;
          try { child.stdin?.end(); } catch {}
          const killTimer = setTimeout(() => {
            if (child.exitCode == null && child.signalCode == null) {
              try { child.kill(); } catch {}
            }
          }, 1_000);
          killTimer.unref?.();
        },
      });
    });
  });
}

export async function createAppServerTransport({
  socketPath,
  command = "codex",
  mode = "auto",
  platform = process.platform,
  environment = process.env,
  connectSocket = connectUnixWebSocket,
  spawnProcess = spawn,
} = {}) {
  const selected = normalizeAppServerTransportMode(mode);
  if (selected === "socket" && platform === "win32") {
    throw new Error("Unix app-server sockets are unavailable on native Windows");
  }
  let socketError = null;
  if (selected !== "stdio" && platform !== "win32") {
    try {
      const transport = await connectSocket(socketPath);
      return { ...transport, kind: "managed-unix-websocket" };
    } catch (error) {
      socketError = error;
      if (selected === "socket") throw error;
    }
  }
  try {
    const transport = await spawnStdioAppServer({ command, platform, environment, spawnProcess });
    if (socketError) transport.fallbackReason = socketError.message;
    return transport;
  } catch (error) {
    if (!socketError) throw error;
    throw new AggregateError([socketError, error], "Neither the managed socket nor stdio Codex app-server is available");
  }
}

export function probeAppServerCommand({
  command = "codex",
  platform = process.platform,
  environment = process.env,
  spawnProcess = spawn,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  let spec;
  try {
    spec = appServerSpawnSpec({ command, args: ["app-server", "--help"], platform, environment });
  } catch (error) {
    return Promise.resolve({ available: false, reason: error.message });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(spec.command, spec.args, {
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ available: false, reason: error.message });
      return;
    }
    let output = "";
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const collect = (chunk) => {
      if (Buffer.byteLength(output) >= MAX_PROBE_BYTES) return;
      output += chunk.toString("utf8").slice(0, MAX_PROBE_BYTES - Buffer.byteLength(output));
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish({ available: false, reason: error.message }));
    child.once("close", (code) => {
      const supportsStdio = /--listen\b|--stdio\b|stdio:\/\//i.test(output);
      finish({
        available: code === 0 && supportsStdio,
        reason: code === 0 && supportsStdio
          ? null
          : code === 0
            ? "Codex app-server does not advertise a stdio transport"
            : `codex app-server --help exited with code ${code}`,
      });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ available: false, reason: "Timed out checking codex app-server" });
    }, timeoutMs);
    timer.unref?.();
  });
}
