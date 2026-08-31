import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findTmuxSessionId } from "./tmux-utils.mjs";

const CRON_MARKER = "# phone-control-managed";
const TMUX_SESSION = "phone-control";
const WINDOWS_TASK = "Phone Control";
const LAUNCHD_LABEL = "com.phone-control.agent";

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

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlUnescape(value) {
  return String(value)
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function parseServiceMetadata(value) {
  if (typeof value !== "string") return null;
  const line = value.split("\n").find((row) => row.startsWith("# phone-control-meta "));
  const launchdMetadata = value.match(/<key>PhoneControlMetadata<\/key>\s*<string>([\s\S]*?)<\/string>/)?.[1];
  const serialized = line
    ? line.slice("# phone-control-meta ".length)
    : launchdMetadata
      ? xmlUnescape(launchdMetadata)
      : null;
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized);
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

export function buildWindowsProxyBootstrap() {
  return `function ConvertTo-PhoneControlProxyUri([string]$Value, [string]$Scheme) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $trimmed = $Value.Trim()
  if ($trimmed -match '^[a-z][a-z0-9+.-]*://') { return $trimmed }
  return ($Scheme + '://' + $trimmed)
}
function Import-PhoneControlWindowsProxy {
  $settings = $null
  try {
    $settings = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop
  } catch {}

  if (-not $env:NO_PROXY) {
    $bypass = @('127.0.0.1', 'localhost', '::1')
    if ($settings -and $settings.ProxyOverride) {
      foreach ($item in ([string]$settings.ProxyOverride -split ';')) {
        $candidate = $item.Trim()
        if (-not $candidate -or $candidate -eq '<local>') { continue }
        if ($candidate.StartsWith('*.')) { $candidate = '.' + $candidate.Substring(2) }
        $bypass += $candidate
      }
    }
    $env:NO_PROXY = ($bypass | Select-Object -Unique) -join ','
  }

  if ($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:ALL_PROXY) { return $false }
  if (-not $settings -or [int]$settings.ProxyEnable -ne 1 -or -not $settings.ProxyServer) { return $false }

  $servers = @{}
  foreach ($item in ([string]$settings.ProxyServer -split ';')) {
    $candidate = $item.Trim()
    if (-not $candidate) { continue }
    $separator = $candidate.IndexOf('=')
    if ($separator -gt 0) {
      $servers[$candidate.Substring(0, $separator).Trim().ToLowerInvariant()] = $candidate.Substring($separator + 1).Trim()
    } elseif (-not $servers.ContainsKey('default')) {
      $servers['default'] = $candidate
    }
  }

  $httpServer = if ($servers.ContainsKey('http')) { $servers['http'] } else { $servers['default'] }
  $httpsServer = if ($servers.ContainsKey('https')) { $servers['https'] } elseif ($httpServer) { $httpServer } else { $servers['default'] }
  if ($httpServer) { $env:HTTP_PROXY = ConvertTo-PhoneControlProxyUri $httpServer 'http' }
  if ($httpsServer) { $env:HTTPS_PROXY = ConvertTo-PhoneControlProxyUri $httpsServer 'http' }
  if ($servers.ContainsKey('socks')) { $env:ALL_PROXY = ConvertTo-PhoneControlProxyUri $servers['socks'] 'socks5' }
  return [bool]($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:ALL_PROXY)
}
`;
}

export function buildWindowsLauncher({ root, dataDir, host, port, runtime = process.execPath }) {
  const metadata = serviceMetadata({ root, runtime });
  const log = path.join(dataDir, "service.log");
  const rotatedLog = `${log}.1`;
  return `${metadataComment(metadata)}\n$ErrorActionPreference = 'Continue'\n$logPath = ${powershellQuote(log)}\n$rotatedLogPath = ${powershellQuote(rotatedLog)}\n${buildWindowsProxyBootstrap()}$phoneControlImportedProxy = Import-PhoneControlWindowsProxy\nif ($phoneControlImportedProxy) {\n  '[phone-control launcher] Imported the current Windows user proxy for background Codex access.' | Add-Content -LiteralPath $logPath\n}\nwhile ($true) {\n  try {\n    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -ge 4194304) {\n      Move-Item -LiteralPath $logPath -Destination $rotatedLogPath -Force\n    }\n    & ${powershellQuote(metadata.runtime)} ${powershellQuote(metadata.entry)} 'start' '--host' ${powershellQuote(host)} '--port' ${powershellQuote(String(port))} '--data-dir' ${powershellQuote(dataDir)} '--no-qr' *>> $logPath\n  } catch {\n    ($_ | Out-String) | Add-Content -LiteralPath $logPath\n  }\n  Start-Sleep -Seconds 2\n}\n`;
}

export function buildWindowsProcessCleanup({ runtime, entry, dataDir }) {
  return `$ErrorActionPreference = 'Stop'
$runtime = ${powershellQuote(runtime)}
$entry = ${powershellQuote(entry)}
$dataDir = ${powershellQuote(dataDir)}
$processes = @(Get-CimInstance Win32_Process)
$roots = @($processes | Where-Object {
  $_.ExecutablePath -ieq $runtime -and
  $_.CommandLine -and
  $_.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine.IndexOf($dataDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine -match '(?i)(?:^|\\s|["''])start(?:\\s|$|["''])'
})
function Stop-PhoneControlProcessTree([int]$ProcessId) {
  foreach ($child in @($processes | Where-Object { $_.ParentProcessId -eq $ProcessId })) {
    Stop-PhoneControlProcessTree $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}
foreach ($rootProcess in $roots) { Stop-PhoneControlProcessTree $rootProcess.ProcessId }
`;
}

export function buildWindowsCallerGuard({ runtime, entry, dataDir }) {
  return `$ErrorActionPreference = 'Stop'
$runtime = ${powershellQuote(runtime)}
$entry = ${powershellQuote(entry)}
$dataDir = ${powershellQuote(dataDir)}
$processes = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }
$current = $byId[[int]$PID]
while ($current -and [int]$current.ParentProcessId -gt 0) {
  $current = $byId[[int]$current.ParentProcessId]
  if (-not $current) { break }
  if ($current.ExecutablePath -ieq $runtime -and
      $current.CommandLine -and
      $current.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $current.CommandLine.IndexOf($dataDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $current.CommandLine -match '(?i)(?:^|\\s|["''])start(?:\\s|$|["''])') {
    [Console]::Error.WriteLine('Phone Control cannot stop or replace its own Windows service from a session hosted by that service. Run this command from a separate PowerShell window or an independent Codex Desktop/CLI session.')
    exit 23
  }
}
`;
}

export function buildLaunchdPlist({ root, dataDir, host, port, runtime = process.execPath }) {
  const metadata = serviceMetadata({ root, runtime });
  const argumentsList = [
    metadata.runtime,
    metadata.entry,
    "start",
    "--host",
    host,
    "--port",
    String(port),
    "--data-dir",
    dataDir,
    "--no-qr",
  ].map((argument) => `    <string>${xmlEscape(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>PhoneControlMetadata</key>
  <string>${xmlEscape(JSON.stringify(metadata))}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(dataDir, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(dataDir, "service-error.log"))}</string>
</dict>
</plist>
`;
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

export function launchdServicePath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function launchdDomain() {
  return `gui/${process.getuid()}`;
}

function launchdTarget() {
  return `${launchdDomain()}/${LAUNCHD_LABEL}`;
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

async function windowsServiceDefinition(dataDir) {
  try {
    return parseServiceMetadata(await readFile(windowsLauncherPath(dataDir), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function assertWindowsCallerOutsideService({ dataDir, definition }) {
  if (!dataDir || !definition) return;
  const guard = await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    buildWindowsCallerGuard({ ...definition, dataDir }),
  ], { inherit: false });
  if (guard.code !== 0) {
    throw new Error(guard.stderr.trim() || guard.stdout.trim() || "The Windows service operation would stop its own caller");
  }
}

async function stopWindowsTask({ dataDir, definition = null } = {}) {
  const selected = definition || (dataDir ? await windowsServiceDefinition(dataDir) : null);
  // A phone-owned Codex thread runs below this service's managed App Server.
  // Refuse before /End so the updater cannot terminate the process that still
  // needs to register and start the replacement scheduled task.
  await assertWindowsCallerOutsideService({ dataDir, definition: selected });
  await run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK], { inherit: false }).catch(() => null);
  if (!selected || !dataDir) return;
  const cleanup = await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    buildWindowsProcessCleanup({ ...selected, dataDir }),
  ], { inherit: false });
  if (cleanup.code !== 0) {
    throw new Error(`Could not stop the previous Phone Control process tree: ${cleanup.stderr.trim() || cleanup.stdout.trim()}`);
  }
}

async function removeWindowsTask(options = {}) {
  await stopWindowsTask(options);
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
  const existingDefinition = await windowsServiceDefinition(dataDir);
  await removeWindowsTask({ dataDir, definition: existingDefinition });
  await atomicWrite(launcher, buildWindowsLauncher({ root, dataDir, host, port, runtime }), 0o700);
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

async function unloadLaunchd(servicePath) {
  await run("launchctl", ["bootout", launchdDomain(), servicePath], { inherit: false }).catch(() => null);
}

async function loadLaunchd(servicePath) {
  const loaded = await run("launchctl", ["bootstrap", launchdDomain(), servicePath], { inherit: false });
  if (loaded.code !== 0) throw new Error(`Could not load the Phone Control launch agent: ${loaded.stderr.trim() || loaded.stdout.trim()}`);
  const started = await run("launchctl", ["kickstart", "-k", launchdTarget()], { inherit: false });
  if (started.code !== 0) throw new Error(`Could not start the Phone Control launch agent: ${started.stderr.trim() || started.stdout.trim()}`);
}

async function installLaunchd({ root, dataDir, host, port, runtime = process.execPath }) {
  await validateServiceRuntime({ root, runtime });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const servicePath = launchdServicePath();
  await mkdir(path.dirname(servicePath), { recursive: true, mode: 0o700 });
  await unloadLaunchd(servicePath);
  await atomicWrite(servicePath, buildLaunchdPlist({ root, dataDir, host, port, runtime }), 0o600);
  await loadLaunchd(servicePath);
  return { kind: "launchd", path: servicePath };
}

export async function installUserService(options) {
  if (process.platform === "win32") return installWindowsTask(options);
  if (process.platform === "darwin") return installLaunchd(options);
  if (await systemdAvailable()) return installSystemd(options);
  return installTmux(options);
}

export async function uninstallUserService({ dataDir }) {
  if (process.platform === "win32") {
    await removeWindowsTask({ dataDir });
    await unlink(windowsLauncherPath(dataDir)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  if (process.platform === "darwin") {
    const servicePath = launchdServicePath();
    await unloadLaunchd(servicePath);
    await unlink(servicePath).catch((error) => {
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
    const definition = await windowsServiceDefinition(dataDir);
    const state = await windowsTaskState();
    return {
      installed: Boolean(definition && state),
      active: state === "Running",
      details: state || "Not installed",
      kind: "scheduled-task",
      definition,
    };
  }
  if (process.platform === "darwin") {
    const servicePath = launchdServicePath();
    let definition = null;
    try {
      definition = parseServiceMetadata(await readFile(servicePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const result = await run("launchctl", ["print", launchdTarget()], { inherit: false }).catch(() => null);
    const active = Boolean(result?.code === 0 && /\bstate\s*=\s*running\b/i.test(result.stdout));
    return {
      installed: Boolean(definition),
      active,
      details: active ? "launch agent running" : definition ? "launch agent installed, inactive" : "Not installed",
      kind: "launchd",
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
    if (action === "stop" || action === "restart") await stopWindowsTask({ dataDir });
    if (action === "start" || action === "restart") {
      const result = await run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], { inherit: false });
      if (result.code !== 0) throw new Error(`Could not ${action} the Phone Control scheduled task: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return;
  }
  if (process.platform === "darwin") {
    const servicePath = launchdServicePath();
    if (action === "stop" || action === "restart") await unloadLaunchd(servicePath);
    if (action === "start" || action === "restart") await loadLaunchd(servicePath);
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
