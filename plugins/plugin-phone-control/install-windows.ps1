[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:USERPROFILE '.phone-control'),
  [ValidateSet('Auto', 'Local', 'Tailscale')]
  [string]$Access = 'Auto',
  [ValidateRange(0, 65535)]
  [int]$Port = 0,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repository = 'https://github.com/under-stand/phone-control.git'
$MarketplaceName = 'phone-control'
$PluginName = 'plugin-phone-control'
$MinimumNodeMajor = 22
$DefaultPort = 8787

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Copy-PluginBundle([string]$From, [string]$To) {
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  Get-ChildItem -LiteralPath $From -Force |
    Where-Object { $_.Name -notin @('.git', 'node_modules') } |
    Copy-Item -Destination $To -Recurse -Force
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (($machinePath, $userPath) | Where-Object { $_ }) -join ';'
}

function Find-Tool([string]$Name, [string[]]$Fallbacks = @()) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  foreach ($candidate in $Fallbacks) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Invoke-Native([string]$File, [string[]]$Arguments, [string]$FailureMessage) {
  $global:LASTEXITCODE = 0
  & $File @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "$FailureMessage (exit $exitCode)" }
}

function Test-Native([string]$File, [string[]]$Arguments) {
  $global:LASTEXITCODE = 0
  & $File @Arguments *> $null
  return ($LASTEXITCODE -eq 0)
}

function Get-NodeMajor([string]$NodePath) {
  if (-not $NodePath) { return 0 }
  $version = (& $NodePath --version 2>$null | Select-Object -First 1)
  if ($version -notmatch '^v?(\d+)') { return 0 }
  return [int]$Matches[1]
}

function Test-PortAvailable([int]$Candidate) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Candidate)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

function Get-StoredPort([string]$ConfigPath) {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  try {
    $stored = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $candidate = [int]$stored.port
    if ($candidate -ge 1024 -and $candidate -le 65535) { return $candidate }
  } catch {}
  return $null
}

function Select-PhoneControlPort([int]$Requested, [string]$ConfigPath) {
  $stored = Get-StoredPort $ConfigPath
  $preferred = if ($Requested -gt 0) { $Requested } elseif ($stored) { $stored } else { $DefaultPort }

  if ($Requested -eq 0 -and $stored -and -not (Test-PortAvailable $stored)) {
    try {
      $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $stored) -TimeoutSec 2
      if ($health.ok -and $health.ready -eq $true) { return $stored }
    } catch {}
  } elseif ($Requested -gt 0 -and -not (Test-PortAvailable $preferred)) {
    throw "Requested Phone Control port $preferred is already in use. Choose another port with -Port."
  }

  for ($offset = 0; $offset -le 20; $offset += 1) {
    $candidate = $preferred + $offset
    if ($candidate -gt 65535) { break }
    if (Test-PortAvailable $candidate) {
      if ($candidate -ne $preferred) {
        Write-Warning "Phone Control port $preferred is already in use; using available port $candidate instead."
      }
      return $candidate
    }
  }
  throw "Could not find an available Phone Control port near $preferred. Choose another port with -Port."
}

function Install-WingetPackage([string]$Id, [string]$Label) {
  $winget = Find-Tool 'winget.exe' @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe')
  )
  if (-not $winget) {
    throw "$Label is required, and winget was not found. Install $Label, then run this installer again."
  }
  Write-Step "Installing or updating $Label"
  & $winget upgrade --id $Id --exact --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    & $winget install --id $Id --exact --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget could not install $Label (exit $LASTEXITCODE)" }
  }
  Refresh-ProcessPath
}

if (-not $env:USERPROFILE) { throw 'USERPROFILE is unavailable; run this installer as a normal Windows user.' }

Write-Host 'Phone Control for Windows' -ForegroundColor Magenta
Write-Host 'Installs into your user profile and creates a current-user startup task.'

$gitFallbacks = @(
  (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe')
)
$git = Find-Tool 'git.exe' $gitFallbacks
if (-not $git) {
  Install-WingetPackage 'Git.Git' 'Git'
  $git = Find-Tool 'git.exe' $gitFallbacks
}
if (-not $git) { throw 'Git was installed but is not visible yet. Open a new PowerShell window and run the installer again.' }

$nodeFallbacks = @(
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
$node = Find-Tool 'node.exe' $nodeFallbacks
if ((Get-NodeMajor $node) -lt $MinimumNodeMajor) {
  Install-WingetPackage 'OpenJS.NodeJS.LTS' "Node.js $MinimumNodeMajor+"
  $node = Find-Tool 'node.exe' $nodeFallbacks
}
if ((Get-NodeMajor $node) -lt $MinimumNodeMajor) {
  throw "Phone Control needs Node.js $MinimumNodeMajor or newer. Open a new PowerShell window after Node installation and retry."
}

$npmFallbacks = @(
  (Join-Path (Split-Path -Parent $node) 'npm.cmd'),
  (Join-Path $env:APPDATA 'npm\npm.cmd')
)
$npm = Find-Tool 'npm.cmd' $npmFallbacks
if (-not $npm) { throw 'npm was not found next to the selected Node.js runtime.' }

$codexFallbacks = @((Join-Path $env:APPDATA 'npm\codex.cmd'))
$codex = Find-Tool 'codex.exe' $codexFallbacks
$pluginCliReady = $false
if ($codex) {
  $pluginCliReady = Test-Native $codex @('plugin', '--help')
}
if (-not $pluginCliReady) {
  Write-Step 'Installing the current Codex CLI for plugin support'
  Invoke-Native $npm @('install', '--global', '@openai/codex@latest') 'Could not install the Codex CLI'
  Refresh-ProcessPath
  $codex = Find-Tool 'codex.exe' $codexFallbacks
}
if (-not $codex) { throw 'Codex was installed but codex.exe is not visible. Open a new PowerShell window and retry.' }
if (-not (Test-Native $codex @('plugin', '--help'))) { throw 'This Codex build does not support plugins. Update Codex, then run this installer again.' }
if (-not (Test-Native $codex @('app-server', '--help'))) { throw 'This Codex build does not provide app-server. Update Codex, then run this installer again.' }

$sourceRoot = Join-Path $InstallRoot 'source'
# This public repository keeps the Codex marketplace at its root and the plugin under
# plugins\plugin-phone-control. Keep the checkout layout identical for ZIP and Git installs.
$pluginRoot = Join-Path $sourceRoot 'plugins\plugin-phone-control'
$bundleRoot = if ($PSScriptRoot) { [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') } else { $null }
$bundleRepoRoot = if ($bundleRoot) { [IO.Path]::GetFullPath((Split-Path (Split-Path $bundleRoot -Parent) -Parent)).TrimEnd('\') } else { $null }
$resolvedSourceRoot = [IO.Path]::GetFullPath($sourceRoot).TrimEnd('\')
$bundleManifest = if ($bundleRoot) { Join-Path $bundleRoot '.codex-plugin\plugin.json' } else { $null }
$localBundle = [bool]$bundleManifest -and (Test-Path -LiteralPath $bundleManifest)
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

Write-Step 'Downloading Phone Control'
if ($localBundle -and -not (Test-Path -LiteralPath $sourceRoot)) {
  Write-Host "Copying the local Phone Control bundle to $sourceRoot"
  Copy-PluginBundle $bundleRepoRoot $sourceRoot
} elseif ($localBundle -and -not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'plugins\plugin-phone-control\.codex-plugin\plugin.json'))) {
    throw "The install directory exists but is not a Phone Control bundle: $sourceRoot"
  }
  Write-Host "Refreshing the local Phone Control bundle at $sourceRoot"
  Copy-PluginBundle $bundleRepoRoot $sourceRoot
} elseif (Test-Path -LiteralPath (Join-Path $sourceRoot '.git')) {
  $global:LASTEXITCODE = 0
  $origin = (& $git -C $sourceRoot remote get-url origin 2>$null | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0) {
    throw "The existing source directory is not the Phone Control repository: $sourceRoot"
  }
  if ($origin -notmatch 'under-stand/phone-control(?:\.git)?$') {
    throw "The existing source directory is not the Phone Control repository: $sourceRoot"
  } else {
    $dirty = (& $git -C $sourceRoot status --porcelain)
    if ($dirty) { throw "The managed checkout has local changes. Preserve or remove them before retrying: $sourceRoot" }
    Invoke-Native $git @('-C', $sourceRoot, 'fetch', 'origin', 'main', '--tags') 'Could not refresh Phone Control'
    Invoke-Native $git @('-C', $sourceRoot, 'checkout', 'main') 'Could not select the main branch'
    Invoke-Native $git @('-C', $sourceRoot, 'pull', '--ff-only', 'origin', 'main') 'Could not update Phone Control'
  }
} elseif (Test-Path -LiteralPath $sourceRoot) {
  throw "The install directory already exists but is not a Git checkout: $sourceRoot"
} else {
  Invoke-Native $git @('clone', '--branch', 'main', '--single-branch', $Repository, $sourceRoot) 'Could not clone Phone Control'
}
if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot '.codex-plugin\plugin.json'))) {
  throw "The downloaded repository does not contain Phone Control: $pluginRoot"
}

$selectedPort = Select-PhoneControlPort $Port (Join-Path $InstallRoot 'config.json')

Write-Step 'Installing service dependencies'
Push-Location $pluginRoot
try {
  Invoke-Native $npm @('ci', '--omit=dev', '--no-audit', '--no-fund') 'npm could not install Phone Control dependencies'
  if (-not $SkipChecks) {
    Invoke-Native $node @('.\scripts\check-source.mjs') 'Phone Control source validation failed'
  }
} finally {
  Pop-Location
}

Write-Step 'Registering the Codex plugin'
$entry = Join-Path $pluginRoot 'bin\phone-control.mjs'
$marketplaceRoot = $sourceRoot
$global:LASTEXITCODE = 0
$marketplaces = (& $codex plugin marketplace list 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not read the Codex plugin marketplaces.' }
if ($marketplaces -match '(?m)^\s*phone-control\s+') {
  Invoke-Native $codex @('plugin', 'marketplace', 'remove', $MarketplaceName) 'Could not refresh the existing Phone Control marketplace'
}
Invoke-Native $codex @('plugin', 'marketplace', 'add', $marketplaceRoot) 'Could not register the Phone Control marketplace'
Invoke-Native $codex @('plugin', 'add', "$PluginName@$MarketplaceName") 'Could not install the Phone Control plugin'

$publicUrl = $null
if ($Access -ne 'Local') {
  $tailscaleFallbacks = @(
    (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
    (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe')
  )
  $tailscale = Find-Tool 'tailscale.exe' $tailscaleFallbacks
  if ($tailscale) {
    $global:LASTEXITCODE = 0
    $statusJson = (& $tailscale status --json 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0 -and $statusJson) {
      try {
        $status = $statusJson | ConvertFrom-Json
        $dnsName = [string]$status.Self.DNSName
        if ($dnsName) {
          Write-Step 'Enabling private Tailscale access'
          $global:LASTEXITCODE = 0
          & $tailscale serve --bg --yes $selectedPort
          if ($LASTEXITCODE -eq 0) { $publicUrl = 'https://' + $dnsName.TrimEnd('.') }
          elseif ($Access -eq 'Tailscale') { throw 'Tailscale Serve could not be enabled. Review the Tailscale message above.' }
          else { Write-Warning 'Tailscale was found, but Serve could not be enabled. The local dashboard will still be installed.' }
        } elseif ($Access -eq 'Tailscale') { throw 'Tailscale is not connected or has no MagicDNS name.' }
      } catch {
        if ($Access -eq 'Tailscale') { throw }
        Write-Warning "Tailscale status could not be used: $($_.Exception.Message)"
      }
    } elseif ($Access -eq 'Tailscale') {
      throw 'Tailscale is installed but not connected. Sign in to Tailscale, then retry.'
    }
  } elseif ($Access -eq 'Tailscale') {
    throw 'Tailscale was requested but is not installed.'
  }
}

Write-Step 'Installing the resilient background service'
if ($publicUrl) {
  $env:PHONE_CONTROL_PUBLIC_URL = $publicUrl
  $env:PHONE_CONTROL_SECURE_COOKIES = '1'
}
Invoke-Native $node @(
  $entry,
  'service', 'install',
  '--runtime', $node,
  '--codex-command', $codex,
  '--app-server-transport', 'auto',
  '--port', $selectedPort
) 'Could not install the Phone Control background task'

$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $selectedPort) -TimeoutSec 2
    if ($health.ok -and $health.ready -eq $true) { $healthy = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 500
}
if (-not $healthy) {
  throw "The background task was installed but did not become healthy. Check $env:USERPROFILE\.phone-control\service.log"
}

Write-Step 'Installation complete'
& $node $entry doctor
Write-Host ''
& $node $entry pair --no-qr
Write-Host ''
Write-Host "Installed source: $sourceRoot"
Write-Host 'Startup task: Phone Control (current user, no administrator rights)'
if ($publicUrl) { Write-Host "Private phone access: $publicUrl" -ForegroundColor Green }
else { Write-Host ("Dashboard: http://127.0.0.1:{0} (computer only until Tailscale or an HTTPS relay is configured)" -f $selectedPort) -ForegroundColor Yellow }
Write-Host ''
Write-Host 'Next: fully quit and reopen Codex, create a new thread, and review /hooks.' -ForegroundColor Yellow
Write-Host 'Native Windows uses a managed local Codex App Server for create, continue, and stop controls.'
Write-Host 'A turn already active in another Codex App process remains observe-only until it becomes safely resumable.'
