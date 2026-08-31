#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { loadConfig, updateConfig } from "../src/config.mjs";
import { requestJson } from "../src/http-client.mjs";
import { dataPaths, resolveCodexHome, resolveDataDir } from "../src/paths.mjs";
import { createPhoneControlServer } from "../src/server.mjs";
import {
  controlUserService,
  installUserService,
  serviceStatus,
  uninstallUserService,
} from "../src/service-manager.mjs";
import { expectedStablePluginRoot, nodeRuntimeStatus, serviceDefinitionStatus } from "../src/service-diagnostics.mjs";
import { probeAppServerCommand } from "../src/app-server-transport.mjs";
import {
  configureRelay,
  controlRelayService,
  installRelayService,
  loadRelayConfig,
  relayDiagnostics,
  relayServiceStatus,
  uninstallRelayService,
  updateRelayConfig,
} from "../src/relay-manager.mjs";
import { PHONE_CONTROL_VERSION } from "../src/version.mjs";
import { defaultMarketplaceRoot, writeMarketplaceManifest } from "../src/marketplace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOLEAN_FLAGS = new Set(["activate", "copy", "no-qr", "open", "secure-cookies"]);

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const args = command === "help" ? argv : argv.slice(1);
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split("=", 2);
    if (BOOLEAN_FLAGS.has(key)) flags[key] = inline == null ? true : inline !== "false";
    else flags[key] = inline ?? args[++index];
  }
  return { command, positionals, flags };
}

function applyEnvironment(flags, command) {
  if (flags.host) process.env.PHONE_CONTROL_HOST = flags.host;
  if (flags.port) process.env.PHONE_CONTROL_PORT = flags.port;
  if (flags["data-dir"]) process.env.PHONE_CONTROL_DATA_DIR = flags["data-dir"];
  if (flags["codex-home"]) process.env.CODEX_HOME = flags["codex-home"];
  if (flags["codex-command"]) process.env.PHONE_CONTROL_CODEX_COMMAND = flags["codex-command"];
  if (flags["app-server-transport"]) process.env.PHONE_CONTROL_APP_SERVER_TRANSPORT = flags["app-server-transport"];
  if (flags["public-url"] && command !== "relay") process.env.PHONE_CONTROL_PUBLIC_URL = flags["public-url"];
  if (flags["secure-cookies"]) process.env.PHONE_CONTROL_SECURE_COOKIES = "1";
}

function printHelp() {
  process.stdout.write(`Phone Control ${PHONE_CONTROL_VERSION}\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  phone-control start [--host HOST] [--port PORT] [--public-url URL] [--codex-command PATH]\n`);
  process.stdout.write(`  phone-control pair [--url URL] [--no-qr] [--copy] [--open]\n`);
  process.stdout.write(`  phone-control share [--url URL]\n`);
  process.stdout.write(`  phone-control approvals <enable|disable|status>\n`);
  process.stdout.write(`  phone-control interactions <enable|disable|status>\n`);
  process.stdout.write(`  phone-control service <install|uninstall|status|start|stop|restart> [--runtime NODE]\n`);
  process.stdout.write(`  phone-control doctor [--data-dir PATH] [--codex-home PATH] [--codex-command PATH]\n\n`);
  process.stdout.write(`  phone-control marketplace install [--plugin-root PATH] [--marketplace-root PATH]\n`);
  process.stdout.write("  phone-control relay <configure|install|uninstall|status|doctor|start|stop|restart|activate|deactivate>\n");
  process.stdout.write("Tailscale Serve or an outbound VPS relay can proxy the default loopback listener.\n");
}

async function countRollouts(root) {
  let count = 0;
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) count += 1;
    }
  }
  await visit(path.join(root, "sessions"));
  return count;
}

async function doctor() {
  const config = await loadConfig();
  const codexHome = resolveCodexHome();
  const rolloutCount = await countRollouts(codexHome);
  const daemon = await serviceStatus({ dataDir: config.dataDir }).catch((error) => ({ installed: false, active: false, details: error.message }));
  const appServerSocket = path.join(codexHome, "app-server-control", "app-server-control.sock");
  const appServerSocketAvailable = process.platform !== "win32"
    && await access(appServerSocket).then(() => true).catch(() => false);
  const appServerCommand = await probeAppServerCommand({ command: config.codexCommand });
  const transportMode = config.interactions.transport;
  const appServerAvailable = transportMode === "socket"
    ? appServerSocketAvailable
    : transportMode === "stdio"
      ? appServerCommand.available
      : appServerSocketAvailable || appServerCommand.available;
  const appServerDetail = appServerSocketAvailable && transportMode !== "stdio"
    ? "Managed Codex App Server socket is available"
    : appServerCommand.available && transportMode !== "socket"
      ? "Managed Codex App Server stdio transport is available"
      : transportMode === "socket"
        ? "Configured Codex App Server socket is unavailable"
        : appServerCommand.reason || "No managed Codex App Server transport is available";
  const node = nodeRuntimeStatus();
  const stableRoot = expectedStablePluginRoot({ currentRoot: ROOT, homeDir: os.homedir() });
  const serviceDefinition = serviceDefinitionStatus({ service: daemon, expectedRoot: stableRoot });
  let deviceCounts = { active: 0, revoked: 0 };
  try {
    const stored = JSON.parse(await readFile(dataPaths(config.dataDir).devices, "utf8"));
    for (const device of stored.devices || []) {
      if (device?.revokedAt) deviceCounts.revoked += 1;
      else if (device?.id) deviceCounts.active += 1;
    }
  } catch {}
  const checks = [
    { ok: node.supported, text: `Node ${process.version}${node.supported ? " is supported" : ` is end-of-life for this service; use Node ${node.minimumMajor}+`}` },
    { ok: daemon.installed && daemon.active, text: daemon.installed ? `Background service is ${daemon.active ? "active" : "inactive"}` : "Background service is not installed" },
    { ok: serviceDefinition.known, text: serviceDefinition.known ? "Service definition includes versioned runtime metadata" : "Service definition is legacy and should be reinstalled" },
    { ok: serviceDefinition.rootMatches, text: serviceDefinition.rootMatches ? "Service starts from this stable plugin checkout" : `Service does not start from stable plugin source ${stableRoot}` },
    { ok: serviceDefinition.runtimeMatches, text: serviceDefinition.runtimeMatches ? "Service runtime matches this verified Node executable" : "Service runtime differs from the current verified Node executable" },
    { ok: appServerAvailable, text: appServerAvailable ? appServerDetail : `${appServerDetail}; sessions remain view-only` },
    { ok: deviceCounts.revoked <= 20, text: `${deviceCounts.active} active device(s), ${deviceCounts.revoked} retained revoked record(s)` },
  ];
  process.stdout.write(`Phone Control doctor\n\n`);
  for (const check of checks) process.stdout.write(`${check.ok ? "[OK]" : "[WARN]"} ${check.text}\n`);
  process.stdout.write(`\nRuntime details\n`);
  process.stdout.write(`Node: ${process.version} (${process.execPath})\n`);
  process.stdout.write(`Plugin root: ${ROOT}\n`);
  process.stdout.write(`Data directory: ${resolveDataDir()}\n`);
  process.stdout.write(`Codex home: ${codexHome}\n`);
  process.stdout.write(`Machine: ${config.machineName}\n`);
  process.stdout.write(`Rollout files found: ${rolloutCount}\n`);
  process.stdout.write(`Dashboard: http://127.0.0.1:${config.port}\n`);
  process.stdout.write(`Phone approvals: ${config.approvals.enabled ? "ENABLED" : "disabled (safe default)"}\n`);
  process.stdout.write(`Phone interactions: ${config.interactions.enabled ? "enabled" : "disabled"}; app-server transport ${transportMode}\n`);
  process.stdout.write(`Codex command: ${config.codexCommand}\n`);
  process.stdout.write(`Background service: ${daemon.installed ? (daemon.active ? "active" : "installed, inactive") : "not installed"}\n`);
  if (daemon.definition) {
    process.stdout.write(`Service runtime: ${daemon.definition.runtime}\n`);
    process.stdout.write(`Service entry: ${daemon.definition.entry}\n`);
  }
  if (config.publicUrl) process.stdout.write(`Private access URL: ${config.publicUrl}\n`);
  process.stdout.write(`Hooks: bundled; review and trust them from Codex /hooks after plugin installation.\n`);
  const warnings = checks.filter((check) => !check.ok).length;
  process.stdout.write(`\nResult: ${warnings ? `${warnings} warning(s); repair the service before relying on unattended access` : "ready for unattended mobile access"}\n`);
}

async function printPairing(pairing, { qr = true, label = "Pair" } = {}) {
  if (!pairing.url) {
    process.stdout.write(`${label}: ${pairing.pathname}\n`);
    return;
  }
  process.stdout.write(`${label}: ${pairing.url}\n`);
  process.stdout.write(`Expires: ${pairing.expiresAt} (single use)\n`);
  if (qr && process.stdout.isTTY) {
    process.stdout.write(`${await QRCode.toString(pairing.url, { type: "terminal", small: true, errorCorrectionLevel: "M" })}\n`);
  }
}

function runClipboardCommand(command, args, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(value);
  });
}

async function copyToClipboard(value) {
  const candidates = process.platform === "win32"
    ? [["clip.exe", []]]
    : process.platform === "darwin"
      ? [["pbcopy", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  let lastError;
  for (const [command, args] of candidates) {
    try {
      await runClipboardCommand(command, args, value);
      return command;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法写入剪贴板，请手动复制链接${lastError ? `（${lastError.message}）` : ""}`);
}

function openInBrowser(url) {
  const command = process.platform === "win32"
    ? "rundll32.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.unref();
      resolve(command);
    }, 250);
    child.once("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      reject(error);
    });
    child.unref();
  });
}

async function start(flags) {
  const config = await loadConfig();
  const runtime = await createPhoneControlServer({ config, pluginRoot: ROOT });
  runtime.store.on("warning", (error) => process.stderr.write(`[phone-control ${new Date().toISOString()}] ${error.message}\n`));
  const addresses = await runtime.start();
  const modes = [config.interactions.enabled ? "live-control" : null, config.approvals.enabled ? "phone-approval" : null].filter(Boolean);
  process.stdout.write(`Phone Control is running in ${modes.length ? modes.join(" + ") : "observe-only"} mode.\n`);
  const preferred = config.publicUrl || flags["public-url"];
  if (preferred) {
    await printPairing(runtime.createPairing({ baseUrl: preferred }), { qr: !flags["no-qr"], label: "Phone" });
  } else {
    await printPairing(runtime.createPairing({ baseUrl: addresses.localUrl }), { qr: false, label: "Desktop" });
    for (const baseUrl of addresses.networkUrls) {
      await printPairing(runtime.createPairing({ baseUrl }), { qr: !flags["no-qr"], label: "Phone" });
    }
  }
  if ((config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1") && !preferred) {
    process.stdout.write(`Phone access requires Tailscale Serve, a trusted reverse proxy, or --host 0.0.0.0 on a trusted network.\n`);
  }
  process.stdout.write(`Keep pairing URLs private. Do not expose this HTTP service directly to the internet.\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
}

async function pair(flags) {
  const config = await loadConfig();
  const baseUrl = flags.url || config.publicUrl || `http://127.0.0.1:${config.port}`;
  const result = await requestJson({
    port: config.port,
    token: config.token,
    path: "/api/internal/pairings",
    method: "POST",
    body: { baseUrl },
    timeoutMs: 2_000,
  });
  const pairing = result.body.pairing;
  await printPairing(pairing, { qr: !flags["no-qr"] });
  if (flags.copy) {
    const command = await copyToClipboard(pairing.url);
    process.stdout.write(`Copied pairing URL to clipboard (${command}).\n`);
  }
  if (flags.open) {
    const command = await openInBrowser(pairing.url);
    process.stdout.write(`Opened pairing URL with ${command}.\n`);
  }
}

async function configureApprovals(action) {
  if (action === "status" || !action) {
    const config = await loadConfig();
    process.stdout.write(`Phone approvals are ${config.approvals.enabled ? "enabled" : "disabled"}.\n`);
    return;
  }
  if (!["enable", "disable"].includes(action)) throw new Error("Use approvals enable, disable, or status");
  const enabled = action === "enable";
  await updateConfig((config) => ({ ...config, approvals: { ...config.approvals, enabled } }));
  process.stdout.write(`Phone approvals ${enabled ? "enabled" : "disabled"}. Restart Phone Control to apply.\n`);
  if (enabled) process.stdout.write(`Each decision is single-use, expires quickly, and is recorded in the local audit log.\n`);
}

async function configureInteractions(action) {
  if (action === "status" || !action) {
    const config = await loadConfig();
    process.stdout.write(`Live phone interactions are ${config.interactions.enabled ? "enabled" : "disabled"}.\n`);
    return;
  }
  if (!["enable", "disable"].includes(action)) throw new Error("Use interactions enable, disable, or status");
  const enabled = action === "enable";
  await updateConfig((config) => ({ ...config, interactions: { ...config.interactions, enabled } }));
  process.stdout.write(`Live phone answers ${enabled ? "enabled" : "disabled"}. Restart Phone Control to apply.\n`);
  if (enabled) process.stdout.write(`Answers require an exact live app-server thread, turn, and request binding.\n`);
}

async function service(action, flags) {
  const config = await loadConfig();
  if (action === "install") {
    const runtime = flags.runtime ? path.resolve(flags.runtime) : process.execPath;
    const installed = await installUserService({ root: ROOT, dataDir: config.dataDir, host: config.host, port: config.port, runtime });
    process.stdout.write(`Installed and started ${installed.kind} service: ${installed.path}\n`);
    return;
  }
  if (action === "uninstall") {
    await uninstallUserService({ dataDir: config.dataDir });
    process.stdout.write(`Removed the Phone Control user service. Local data was kept.\n`);
    return;
  }
  if (["start", "stop", "restart"].includes(action)) {
    await controlUserService(action, { dataDir: config.dataDir });
    process.stdout.write(`Service ${action} completed.\n`);
    return;
  }
  const status = await serviceStatus({ dataDir: config.dataDir });
  process.stdout.write(`${status.kind}: ${status.installed ? "installed" : "not installed"}; ${status.active ? "active" : "inactive"}${status.details ? ` (${status.details})` : ""}\n`);
}

async function marketplace(action, flags) {
  if (action !== "install") throw new Error("Use marketplace install");
  const pluginRoot = path.resolve(flags["plugin-root"] || ROOT);
  const marketplaceRoot = path.resolve(flags["marketplace-root"] || defaultMarketplaceRoot());
  const result = await writeMarketplaceManifest({ pluginRoot, marketplaceRoot });
  process.stdout.write(`Wrote Phone Control marketplace: ${result.manifestPath}\n`);
  process.stdout.write(`Register it with: codex plugin marketplace add ${result.marketplaceRoot}\n`);
}

async function relay(action, flags) {
  const config = await loadConfig();
  if (action === "configure") {
    for (const required of ["client", "token-file", "server", "server-port", "remote-port", "public-url"]) {
      if (!flags[required]) throw new Error("relay configure requires --" + required);
    }
    const existingRelay = await loadRelayConfig(config.dataDir);
    if (existingRelay?.active) {
      throw new Error("Deactivate the active relay before changing its endpoint");
    }
    const configured = await configureRelay({
      dataDir: config.dataDir,
      clientPath: flags.client,
      tokenFile: flags["token-file"],
      serverAddr: flags.server,
      serverPort: flags["server-port"],
      remotePort: flags["remote-port"],
      publicUrl: flags["public-url"],
      localPort: config.port,
      proxyName: flags.name || "phone-control-" + config.machineName,
      previousPublicUrl: existingRelay?.previousPublicUrl || config.publicUrl,
      previousSecureCookies: existingRelay?.previousSecureCookies ?? config.secureCookies,
    });
    process.stdout.write(
      "Configured " + configured.kind + " relay " + configured.serverAddr + ":" + configured.serverPort
        + " -> 127.0.0.1:" + configured.localPort + ".\n",
    );
    process.stdout.write("Public relay URL: " + configured.publicUrl + "\n");
    if (flags.activate) await relay("activate", flags);
    else process.stdout.write("The existing public URL is unchanged; run relay activate after HTTPS verification.\n");
    return;
  }
  if (action === "install") {
    const installed = await installRelayService({ dataDir: config.dataDir });
    process.stdout.write("Installed and started " + installed.kind + " relay service: " + installed.path + "\n");
    return;
  }
  if (action === "uninstall") {
    await uninstallRelayService({ dataDir: config.dataDir });
    process.stdout.write("Removed the relay background service. Relay configuration was kept.\n");
    return;
  }
  if (["start", "stop", "restart"].includes(action)) {
    await controlRelayService(action, { dataDir: config.dataDir });
    process.stdout.write("Relay service " + action + " completed.\n");
    return;
  }
  if (action === "activate") {
    const configured = await loadRelayConfig(config.dataDir);
    if (!configured) throw new Error("Relay is not configured");
    const diagnostics = await relayDiagnostics({ dataDir: config.dataDir });
    if (!diagnostics.checks.every((check) => check.ok)) {
      throw new Error("Relay doctor must pass before activation");
    }
    await updateConfig((current) => ({ ...current, publicUrl: configured.publicUrl, secureCookies: true }));
    await updateRelayConfig(config.dataDir, (current) => ({
      ...current,
      active: true,
      previousPublicUrl: current.previousPublicUrl || config.publicUrl || null,
      previousSecureCookies: current.previousSecureCookies ?? config.secureCookies,
    }));
    process.stdout.write("Relay activated for new pairing links. Restart Phone Control to apply.\n");
    return;
  }
  if (action === "deactivate") {
    const configured = await loadRelayConfig(config.dataDir);
    if (!configured) throw new Error("Relay is not configured");
    await updateConfig((current) => ({
      ...current,
      publicUrl: configured.previousPublicUrl || null,
      secureCookies: configured.previousSecureCookies
        ?? Boolean(configured.previousPublicUrl?.startsWith("https://")),
    }));
    await updateRelayConfig(config.dataDir, (current) => ({ ...current, active: false }));
    process.stdout.write("Relay deactivated; the previous public URL was restored. Restart Phone Control to apply.\n");
    return;
  }
  if (action === "doctor") {
    const diagnostics = await relayDiagnostics({ dataDir: config.dataDir });
    process.stdout.write("Phone Control relay doctor\n\n");
    if (!diagnostics.configured) {
      process.stdout.write("[WARN] Relay is not configured\n");
      return;
    }
    for (const check of diagnostics.checks) {
      process.stdout.write((check.ok ? "[OK] " : "[WARN] ") + check.text + "\n");
    }
    process.stdout.write("\nMode: " + diagnostics.relay.kind + (diagnostics.relay.active ? " (active)" : " (standby)") + "\n");
    process.stdout.write("Public URL: " + diagnostics.relay.publicUrl + "\n");
    process.stdout.write("Server: " + diagnostics.relay.serverAddr + ":" + diagnostics.relay.serverPort + "\n");
    process.stdout.write("Remote port: " + diagnostics.relay.remotePort + "\n");
    return;
  }
  const configured = await loadRelayConfig(config.dataDir);
  const status = await relayServiceStatus({ dataDir: config.dataDir });
  process.stdout.write(
    status.kind + ": " + (status.installed ? "installed" : "not installed") + "; "
      + (status.active ? "active" : "inactive") + (status.details ? " (" + status.details + ")" : "") + "\n",
  );
  if (configured) {
    process.stdout.write(
      "Relay: " + configured.publicUrl + (configured.active ? " (active for pairing)" : " (standby)") + "\n",
    );
  }
}

const { command, positionals, flags } = parse(process.argv.slice(2));
applyEnvironment(flags, command);

try {
  if (command === "start") await start(flags);
  else if (command === "doctor") await doctor();
  else if (command === "pair" || command === "url") await pair(flags);
  else if (command === "share") await pair({ ...flags, copy: true, open: true, "no-qr": true });
  else if (command === "approvals") await configureApprovals(positionals[0]);
  else if (command === "interactions") await configureInteractions(positionals[0]);
  else if (command === "service") await service(positionals[0] || "status", flags);
  else if (command === "marketplace") await marketplace(positionals[0] || "install", flags);
  else if (command === "relay") await relay(positionals[0] || "status", flags);
  else {
    printHelp();
    if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`phone-control: ${error.message}\n`);
  process.exitCode = 1;
}
