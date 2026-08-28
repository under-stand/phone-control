import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataPaths } from "./paths.mjs";
import { findTmuxSessionId } from "./tmux-utils.mjs";
import { safeJsonParse } from "./utils.mjs";

const RELAY_SESSION = "phone-control-relay";
const RELAY_CRON_MARKER = "# phone-control-relay-managed";

function run(command, args, { inherit = true, input = null, env = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    if (!inherit) child.stdin.end(input || undefined);
  });
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

function systemdQuote(value) {
  return "\"" + String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"") + "\"";
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function validPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(label + " must be a valid TCP port");
  }
  return port;
}

function validPublicUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Relay public URL is invalid");
  }
  if (parsed.protocol !== "https:") throw new Error("Relay public URL must use HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Relay public URL must not contain credentials, a query, or a fragment");
  }
  return parsed.href.replace(/\/$/, "");
}

function validServerAddress(value) {
  const serverAddr = String(value || "").trim();
  if (!serverAddr || /[\s/\\]/.test(serverAddr)) throw new Error("Relay server address is invalid");
  return serverAddr;
}

function validProxyName(value) {
  const normalized = String(value || "phone-control")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "phone-control";
}

async function atomicWrite(filePath, body, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = filePath + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(temporary, body, { mode });
  await rename(temporary, filePath);
  await chmod(filePath, mode);
}

export function buildFrpcConfig({
  serverAddr,
  serverPort,
  authTokenFile,
  proxyName,
  localHost = "127.0.0.1",
  localPort = 8787,
  remotePort,
}) {
  if (!authTokenFile || !path.isAbsolute(authTokenFile)) throw new Error("Relay authentication token file must be absolute");
  const fields = {
    serverAddr: validServerAddress(serverAddr),
    serverPort: validPort(serverPort, "Relay server port"),
    localPort: validPort(localPort, "Local Phone Control port"),
    remotePort: validPort(remotePort, "Relay remote port"),
  };
  return [
    "serverAddr = " + tomlString(fields.serverAddr),
    "serverPort = " + fields.serverPort,
    "loginFailExit = false",
    "auth.method = \"token\"",
    "auth.tokenSource.type = \"file\"",
    "auth.tokenSource.file.path = " + tomlString(authTokenFile),
    "transport.tls.enable = true",
    "transport.wireProtocol = \"v2\"",
    "transport.tcpMux = true",
    "transport.tcpMuxKeepaliveInterval = 15",
    "transport.heartbeatInterval = 15",
    "transport.heartbeatTimeout = 45",
    "",
    "[[proxies]]",
    "name = " + tomlString(validProxyName(proxyName)),
    "type = \"tcp\"",
    "localIP = " + tomlString(localHost),
    "localPort = " + fields.localPort,
    "remotePort = " + fields.remotePort,
    "transport.useEncryption = true",
    "",
    "[proxies.healthCheck]",
    "type = \"http\"",
    "path = \"/api/health\"",
    "intervalSeconds = 10",
    "timeoutSeconds = 3",
    "maxFailed = 3",
    "",
  ].join("\n");
}

export function buildRelaySystemdUnit({ clientPath, clientConfigPath }) {
  return [
    "[Unit]",
    "Description=Phone Control outbound FRP relay",
    "After=network-online.target phone-control.service",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=" + systemdQuote(clientPath) + " -c " + systemdQuote(clientConfigPath),
    "Restart=always",
    "RestartSec=2",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function buildRelayTmuxLauncher({ clientPath, clientConfigPath, logPath }) {
  return [
    "#!/bin/sh",
    "while true; do",
    "  if [ -f " + shellQuote(logPath) + " ] && [ \"$(wc -c < " + shellQuote(logPath) + ")\" -ge 2097152 ]; then",
    "    mv " + shellQuote(logPath) + " " + shellQuote(logPath + ".1"),
    "  fi",
    "  " + shellQuote(clientPath) + " -c " + shellQuote(clientConfigPath) + " >> " + shellQuote(logPath) + " 2>&1",
    "  sleep 2",
    "done",
    "",
  ].join("\n");
}

export async function configureRelay({
  dataDir,
  clientPath,
  tokenFile,
  serverAddr,
  serverPort,
  remotePort,
  publicUrl,
  localPort = 8787,
  proxyName,
  previousPublicUrl = null,
  previousSecureCookies = null,
}) {
  const paths = dataPaths(dataDir);
  const resolvedClient = path.resolve(clientPath);
  const resolvedToken = path.resolve(tokenFile);
  await access(resolvedClient);
  const executable = await stat(resolvedClient);
  if (!executable.isFile()) throw new Error("FRP client path is not a file");
  const authToken = (await readFile(resolvedToken, "utf8")).trim();
  if (authToken.length < 32) throw new Error("Relay authentication token must contain at least 32 characters");
  const normalized = {
    version: 1,
    kind: "frp",
    active: false,
    clientPath: resolvedClient,
    clientConfigPath: paths.relayClientConfig,
    serverAddr: validServerAddress(serverAddr),
    serverPort: validPort(serverPort, "Relay server port"),
    remotePort: validPort(remotePort, "Relay remote port"),
    localHost: "127.0.0.1",
    localPort: validPort(localPort, "Local Phone Control port"),
    publicUrl: validPublicUrl(publicUrl),
    proxyName: validProxyName(proxyName),
    previousPublicUrl: previousPublicUrl || null,
    previousSecureCookies: typeof previousSecureCookies === "boolean" ? previousSecureCookies : null,
  };
  const clientConfig = buildFrpcConfig({ ...normalized, authTokenFile: paths.relayToken });
  await atomicWrite(paths.relayToken, authToken + "\n");
  await atomicWrite(paths.relayClientConfig, clientConfig);
  await atomicWrite(paths.relayConfig, JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

export async function loadRelayConfig(dataDir) {
  const filePath = dataPaths(dataDir).relayConfig;
  let parsed;
  try {
    parsed = safeJsonParse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (parsed?.version !== 1 || parsed.kind !== "frp") {
    throw new Error("Relay configuration is unsupported or damaged");
  }
  return parsed;
}

export async function updateRelayConfig(dataDir, mutator) {
  const current = await loadRelayConfig(dataDir);
  if (!current) throw new Error("Relay is not configured");
  const next = mutator({ ...current }) || current;
  await atomicWrite(dataPaths(dataDir).relayConfig, JSON.stringify(next, null, 2) + "\n");
  return next;
}

async function validateClient(relay) {
  const result = await run(relay.clientPath, ["verify", "-c", relay.clientConfigPath], { inherit: false });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "exit " + result.code;
    throw new Error("FRP client configuration is invalid: " + detail);
  }
}

function relaySystemdPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", "phone-control-relay.service");
}

async function systemdAvailable() {
  if (process.platform !== "linux") return false;
  const result = await run("systemctl", ["--user", "is-system-running"], { inherit: false }).catch(() => null);
  return Boolean(result && !/D-Bus connection|Failed to connect to bus/i.test(result.stdout + result.stderr));
}

async function currentCrontab() {
  const result = await run("crontab", ["-l"], { inherit: false });
  return result.code === 0 ? result.stdout : "";
}

async function installCrontab(line) {
  const existing = (await currentCrontab()).split("\n").filter((row) => !row.includes(RELAY_CRON_MARKER) && row.trim());
  existing.push(line + " " + RELAY_CRON_MARKER);
  const result = await run("crontab", ["-"], { inherit: false, input: existing.join("\n") + "\n" });
  if (result.code !== 0) throw new Error("Could not install the relay @reboot entry: " + result.stderr.trim());
}

async function removeCrontabEntry() {
  const existing = (await currentCrontab()).split("\n").filter((row) => !row.includes(RELAY_CRON_MARKER) && row.trim());
  const input = existing.length ? existing.join("\n") + "\n" : "";
  const result = await run("crontab", ["-"], { inherit: false, input });
  if (result.code !== 0) throw new Error("Could not remove the relay @reboot entry: " + result.stderr.trim());
}

async function startTmux(dataDir) {
  if (await tmuxSessionId()) return;
  const env = { ...process.env };
  delete env.TMUX;
  const launcher = dataPaths(dataDir).relayLauncher;
  const result = await run("tmux", ["new-session", "-d", "-s", RELAY_SESSION, launcher], { inherit: false, env });
  if (result.code !== 0) throw new Error("Could not start the relay service: " + result.stderr.trim());
}

async function tmuxSessionId() {
  const result = await run("tmux", ["list-sessions", "-F", "#{session_id}\t#{session_name}"], { inherit: false });
  return result.code === 0 ? findTmuxSessionId(result.stdout, RELAY_SESSION) : null;
}

async function stopTmux() {
  const sessionId = await tmuxSessionId();
  if (sessionId) await run("tmux", ["kill-session", "-t", sessionId], { inherit: false });
}

export async function installRelayService({ dataDir }) {
  const relay = await loadRelayConfig(dataDir);
  if (!relay) throw new Error("Configure the relay before installing it");
  await validateClient(relay);
  if (await systemdAvailable()) {
    const servicePath = relaySystemdPath();
    await mkdir(path.dirname(servicePath), { recursive: true, mode: 0o700 });
    await atomicWrite(servicePath, buildRelaySystemdUnit(relay));
    for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", "phone-control-relay.service"]]) {
      const result = await run("systemctl", args);
      if (result.code !== 0) throw new Error("systemctl " + args.slice(1).join(" ") + " failed");
    }
    return { kind: "systemd", path: servicePath };
  }
  const paths = dataPaths(dataDir);
  await atomicWrite(paths.relayLauncher, buildRelayTmuxLauncher({
    clientPath: relay.clientPath,
    clientConfigPath: relay.clientConfigPath,
    logPath: paths.relayLog,
  }), 0o700);
  await installCrontab("@reboot tmux new-session -d -s " + RELAY_SESSION + " " + shellQuote(paths.relayLauncher));
  await stopTmux();
  await startTmux(dataDir);
  return { kind: "tmux+cron", path: paths.relayLauncher };
}

export async function relayServiceStatus({ dataDir }) {
  if (await systemdAvailable()) {
    const result = await run("systemctl", ["--user", "is-active", "phone-control-relay.service"], { inherit: false });
    const installed = await access(relaySystemdPath()).then(() => true).catch(() => false);
    return {
      kind: "systemd",
      installed,
      active: result.stdout.trim() === "active",
      details: result.stdout.trim() || result.stderr.trim(),
    };
  }
  const installed = await access(dataPaths(dataDir).relayLauncher).then(() => true).catch(() => false);
  const active = Boolean(await tmuxSessionId());
  return {
    kind: "tmux+cron",
    installed,
    active,
    details: active ? "tmux session active" : "tmux session inactive",
  };
}

export async function controlRelayService(action, { dataDir }) {
  if (!["start", "stop", "restart"].includes(action)) {
    throw new Error("Unsupported relay service action");
  }
  if (await systemdAvailable()) {
    const result = await run("systemctl", ["--user", action, "phone-control-relay.service"]);
    if (result.code !== 0) throw new Error("systemctl --user " + action + " phone-control-relay.service failed");
    return;
  }
  if (action === "stop" || action === "restart") {
    await stopTmux();
  }
  if (action === "start" || action === "restart") await startTmux(dataDir);
}

export async function uninstallRelayService({ dataDir }) {
  if (await systemdAvailable()) {
    await run("systemctl", ["--user", "disable", "--now", "phone-control-relay.service"]);
    await unlink(relaySystemdPath()).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await run("systemctl", ["--user", "daemon-reload"]);
  } else {
    await stopTmux();
    await removeCrontabEntry();
    await unlink(dataPaths(dataDir).relayLauncher).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function probe(url, timeoutMs = 5_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

export async function relayDiagnostics({ dataDir }) {
  const relay = await loadRelayConfig(dataDir);
  if (!relay) return { configured: false, checks: [] };
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  const clientExists = await access(relay.clientPath).then(() => true).catch(() => false);
  add(clientExists, clientExists ? "FRP client binary found" : "FRP client binary is missing");
  let clientValid = false;
  if (clientExists) clientValid = await validateClient(relay).then(() => true).catch(() => false);
  add(clientValid, clientValid ? "FRP client configuration is valid" : "FRP client configuration is invalid");
  const service = await relayServiceStatus({ dataDir }).catch((error) => ({
    installed: false,
    active: false,
    details: error.message,
  }));
  add(
    service.installed && service.active,
    "Relay background service is " + (service.active ? "active" : service.installed ? "inactive" : "not installed"),
  );
  const localUrl = "http://" + relay.localHost + ":" + relay.localPort + "/api/health";
  const local = await probe(localUrl).then(() => true).catch(() => false);
  add(local, local ? "Local Phone Control health endpoint is reachable" : "Local Phone Control health endpoint is unavailable");
  const publicHealth = await probe(relay.publicUrl + "/api/health").then(() => true).catch(() => false);
  add(publicHealth, publicHealth ? "Public HTTPS relay reaches Phone Control" : "Public HTTPS relay is unavailable");
  return { configured: true, relay, service, checks };
}
