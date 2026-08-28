import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findTmuxSessionId } from "./tmux-utils.mjs";

const CRON_MARKER = "# phone-control-managed";
const TMUX_SESSION = "phone-control";
const WINDOWS_TASK = "Phone Control";

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

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function serviceMetadata({ root, runtime = process.execPath }) {
  return { runtime, entry: path.join(root, "bin", "phone-control.mjs") };
}

function metadataComment(metadata) {
  return `# phone-control-meta ${JSON.stringify(metadata)}`;
}

export function parseServiceMetadata(value) {
  if (typeof value !== "string") return null;
  const line = value.split("\n").find((row) => row.startsWith("# phone-control-meta "));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice("# phone-control-meta ".length));
    return typeof parsed.runtime === "string" && typeof parsed.entry === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function buildSystemdUnit({ root, dataDir, host, port, runtime = process.execPath }) {
  const metadata = serviceMetadata({ root, runtime });
  return `${metadataComment(metadata)}\n[Unit]\nDescription=Phone Control local Codex dashboard\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(metadata.runtime)} ${systemdQuote(metadata.entry)} start --host ${systemdQuote(host)} --port ${port} --data-dir ${systemdQuote(dataDir)} --no-qr\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
}

export function buildTmuxLauncher({ root, dataDir, host, port, runtime = process.execPath }) {
  const metadata = serviceMetadata({ root, runtime });
  const log = path.join(dataDir, "service.log");
  return `#!/bin/sh\n${metadataComment(metadata)}\nwhile true; do\n  if [ -f ${shellQuote(log)} ] && [ "$(wc -c < ${shellQuote(log)})" -ge 4194304 ]; then\n    mv ${shellQuote(log)} ${shellQuote(`${log}.1`)}\n  fi\n  ${shellQuote(metadata.runtime)} ${shellQuote(metadata.entry)} start --host ${shellQuote(host)} --port ${port} --data-dir ${shellQuote(dataDir)} --no-qr >> ${shellQuote(log)} 2>&1\n  sleep 2\ndone\n`;
}

export function buildWindowsLauncher({ root, dataDir, host, port, runtime = process.execPath }) {
  const metadata = serviceMetadata({ root, runtime });
  const log = path.join(dataDir, "service.log");
  const rotatedLog = `${log}.1`;
  return `${metadataComment(metadata)}\n$ErrorActionPreference = 'Continue'\n$logPath = ${powershellQuote(log)}\n$rotatedLogPath = ${powershellQuote(rotatedLog)}\nwhile ($true) {\n  try {\n    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -ge 4194304) {\n      Move-Item -LiteralPath $logPath -Destination $rotatedLogPath -Force\n    }\n    & ${powershellQuote(metadata.runtime)} ${powershellQuote(metadata.entry)} 'start' '--host' ${powershellQuote(host)} '--port' ${powershellQuote(String(port))} '--data-dir' ${powershellQuote(dataDir)} '--no-qr' *>> $logPath\n  } catch {\n    ($_ | Out-String) | Add-Content -LiteralPath $logPath\n  }\n  Start-Sleep -Seconds 2\n}\n`;
}

export function buildWindowsTaskAction(launcherPath) {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${String(launcherPath).replaceAll('"', '""')}"`;
}

export function buildWindowsTaskRegistration(launcherPath) {
  const action = buildWindowsTaskAction(launcherPath).slice("powershell.exe ".length);
  return `$ErrorActionPreference = 'Stop'; $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${powershellQuote(action)}; $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity; $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName ${powershellQuote(WINDOWS_TASK)} -Description 'Phone Control local Codex dashboard' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`;
}

async function atomicWrite(filePath, body, mode) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, body, { mode });
  await rename(temporary, filePath);
  if (process.platform !== "win32") await chmod(filePath, mode);
}

async function validateServiceRuntime({ root, runtime = process.execPath }) {
  const metadata = serviceMetadata({ root, runtime });
  await Promise.all([access(metadata.runtime), access(metadata.entry)]);
  const result = await run(metadata.runtime, [metadata.entry, "--help"], { inherit: false });
  if (result.code !== 0) throw new Error(`The selected Node runtime cannot start Phone Control: ${result.stderr.trim() || `exit ${result.code}`}`);
  return metadata;
}

export function userServicePath() {
  return path.join(os.homedir(), ".config", "systemd", "user", "phone-control.service");
}

function daemonLauncherPath(dataDir) {
  return path.join(dataDir, "run-service.sh");
}

function windowsLauncherPath(dataDir) {
  return path.join(dataDir, "run-service.ps1");
}

async function systemdAvailable() {
  if (process.platform !== "linux") return false;
  const result = await run("systemctl", ["--user", "is-system-running"], { inherit: false }).catch(() => null);
  return Boolean(result && !/D-Bus connection|Failed to connect to bus/i.test(`${result.stdout}${result.stderr}`));
}

async function installSystemd({ root, dataDir, host, port, runtime = process.execPath }) {
  await validateServiceRuntime({ root, runtime });
  const servicePath = userServicePath();
  await mkdir(path.dirname(servicePath), { recursive: true, mode: 0o700 });
  await atomicWrite(servicePath, buildSystemdUnit({ root, dataDir, host, port, runtime }), 0o600);
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) throw new Error("systemctl --user daemon-reload failed");
  const enabled = await run("systemctl", ["--user", "enable", "phone-control.service"]);
  if (enabled.code !== 0) throw new Error("Could not enable the Phone Control user service");
  const restarted = await run("systemctl", ["--user", "restart", "phone-control.service"]);
  if (restarted.code !== 0) throw new Error("Could not restart the Phone Control user service");
  return { kind: "systemd", path: servicePath };
}

async function currentCrontab() {
  const result = await run("crontab", ["-l"], { inherit: false });
  return result.code === 0 ? result.stdout : "";
}

async function installCrontab(line) {
  const existing = (await currentCrontab()).split("\n").filter((row) => !row.includes(CRON_MARKER) && row.trim());
  existing.push(`${line} ${CRON_MARKER}`);
  const result = await run("crontab", ["-"], { inherit: false, input: `${existing.join("\n")}\n` });
  if (result.code !== 0) throw new Error(`Could not install Phone Control @reboot entry: ${result.stderr.trim()}`);
}

async function removeCrontabEntry() {
  const existing = (await currentCrontab()).split("\n").filter((row) => !row.includes(CRON_MARKER) && row.trim());
  const result = await run("crontab", ["-"], { inherit: false, input: existing.length ? `${existing.join("\n")}\n` : "" });
  if (result.code !== 0) throw new Error(`Could not remove Phone Control @reboot entry: ${result.stderr.trim()}`);
}

async function startTmux(dataDir) {
  if (await tmuxSessionId()) return;
  const env = { ...process.env };
  delete env.TMUX;
  const result = await run("tmux", ["new-session", "-d", "-s", TMUX_SESSION, daemonLauncherPath(dataDir)], { inherit: false, env });
  if (result.code !== 0) throw new Error(`Could not start tmux service: ${result.stderr.trim()}`);
}

async function tmuxSessionId() {
  const result = await run("tmux", ["list-sessions", "-F", "#{session_id}\t#{session_name}"], { inherit: false });
  return result.code === 0 ? findTmuxSessionId(result.stdout, TMUX_SESSION) : null;
}

async function stopTmux() {
  const sessionId = await tmuxSessionId();
  if (sessionId) await run("tmux", ["kill-session", "-t", sessionId], { inherit: false });
}

async function installTmux({ root, dataDir, host, port, runtime = process.execPath }) {
  const tmux = await run("tmux", ["-V"], { inherit: false });
  if (tmux.code !== 0) throw new Error("Neither a systemd user manager nor tmux is available");
  await validateServiceRuntime({ root, runtime });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const launcher = daemonLauncherPath(dataDir);
  await atomicWrite(launcher, buildTmuxLauncher({ root, dataDir, host, port, runtime }), 0o700);
  await installCrontab(`@reboot tmux new-session -d -s ${TMUX_SESSION} ${shellQuote(launcher)}`);
  await stopTmux();
  await startTmux(dataDir);
  return { kind: "tmux+cron", path: launcher };
}

async function stopWindowsTask() {
  await run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK], { inherit: false }).catch(() => null);
}

async function removeWindowsTask() {
  await stopWindowsTask();
  await run("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { inherit: false }).catch(() => null);
}

async function windowsTaskState() {
  const command = `$task = Get-ScheduledTask -TaskName '${WINDOWS_TASK.replaceAll("'", "''")}' -ErrorAction SilentlyContinue; if ($null -eq $task) { exit 3 }; [Console]::Out.Write($task.State.ToString())`;
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { inherit: false }).catch(() => null);
  return result?.code === 0 ? result.stdout.trim() : null;
}

async function installWindowsTask({ root, dataDir, host, port, runtime = process.execPath }) {
  await validateServiceRuntime({ root, runtime });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const launcher = windowsLauncherPath(dataDir);
  await atomicWrite(launcher, buildWindowsLauncher({ root, dataDir, host, port, runtime }), 0o700);
  await removeWindowsTask();
  const created = await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    buildWindowsTaskRegistration(launcher),
  ], { inherit: false });
  if (created.code !== 0) throw new Error(`Could not create the Phone Control scheduled task: ${created.stderr.trim() || created.stdout.trim()}`);
  const started = await run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], { inherit: false });
  if (started.code !== 0) throw new Error(`Could not start the Phone Control scheduled task: ${started.stderr.trim() || started.stdout.trim()}`);
  return { kind: "scheduled-task", path: launcher };
}

export async function installUserService(options) {
  if (process.platform === "win32") return installWindowsTask(options);
  if (await systemdAvailable()) return installSystemd(options);
  return installTmux(options);
}

export async function uninstallUserService({ dataDir }) {
  if (process.platform === "win32") {
    await removeWindowsTask();
    await unlink(windowsLauncherPath(dataDir)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  if (await systemdAvailable()) {
    await run("systemctl", ["--user", "disable", "--now", "phone-control.service"]);
    await unlink(userServicePath()).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await run("systemctl", ["--user", "daemon-reload"]);
  }
  await stopTmux();
  await removeCrontabEntry();
  await unlink(daemonLauncherPath(dataDir)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function serviceStatus({ dataDir } = {}) {
  if (process.platform === "win32") {
    let definition = null;
    try {
      definition = parseServiceMetadata(await readFile(windowsLauncherPath(dataDir), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const state = await windowsTaskState();
    return {
      installed: Boolean(definition && state),
      active: state === "Running",
      details: state || "Not installed",
      kind: "scheduled-task",
      definition,
    };
  }
  if (await systemdAvailable()) {
    let definition;
    try {
      definition = await readFile(userServicePath(), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { installed: false, active: false, details: "Not installed", kind: "systemd" };
      throw error;
    }
    const result = await run("systemctl", ["--user", "is-active", "phone-control.service"], { inherit: false });
    return { installed: true, active: result.stdout.trim() === "active", details: result.stdout.trim() || result.stderr.trim(), kind: "systemd", definition: parseServiceMetadata(definition) };
  }
  let installed = false;
  let definition = null;
  try {
    definition = parseServiceMetadata(await readFile(daemonLauncherPath(dataDir), "utf8"));
    installed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const active = Boolean(await tmuxSessionId());
  return { installed, active, details: active ? "tmux session active" : "tmux session inactive", kind: "tmux+cron", definition };
}

export async function controlUserService(action, { dataDir }) {
  if (!["start", "stop", "restart"].includes(action)) throw new Error("Unsupported service action");
  if (process.platform === "win32") {
    if (action === "stop" || action === "restart") await stopWindowsTask();
    if (action === "start" || action === "restart") {
      const result = await run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], { inherit: false });
      if (result.code !== 0) throw new Error(`Could not ${action} the Phone Control scheduled task: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return;
  }
  if (await systemdAvailable()) {
    const result = await run("systemctl", ["--user", action, "phone-control.service"]);
    if (result.code !== 0) throw new Error(`systemctl --user ${action} failed`);
    return;
  }
  if (action === "stop" || action === "restart") {
    await stopTmux();
  }
  if (action === "start" || action === "restart") await startTmux(dataDir);
}
