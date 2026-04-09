function Normalize-Path {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)

  if ($fullPath.StartsWith("\\?\")) {
    return $fullPath.Substring(4)
  }

  return $fullPath
}

function Test-IsAdministrator {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-DirectoryWritable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $probe = Join-Path $Path ".clockbot-write-probe-$PID-$([Guid]::NewGuid().ToString('N'))"
    Set-Content -LiteralPath $probe -Value "" -Encoding ascii
    Remove-Item -LiteralPath $probe -Force
    return $true
  }
  catch {
    return $false
  }
}

function Get-TargetProfileRoot {
  $envOverride = [Environment]::GetEnvironmentVariable("CLOCKBOT_PLAYWRIGHT_PROFILE_DIR")
  if ($envOverride -and $envOverride.Trim()) {
    return ,(Normalize-Path $envOverride.Trim())
  }

  $clockBotRoot = Normalize-Path (Join-Path $env:APPDATA "ClockBot")
  return @(
    (Join-Path $clockBotRoot "automation-profile"),
    (Join-Path $clockBotRoot "automation-profile-v2")
  )
}

function Test-ProfileDirectoryUsable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-DirectoryWritable $Path)) {
    return $false
  }

  $defaultPath = Join-Path $Path "Default"
  if (-not (Test-Path -LiteralPath $defaultPath -PathType Container)) {
    return $true
  }

  return (Test-DirectoryWritable $defaultPath)
}

function Clear-TargetProfileRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    return
  }

  Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
  }
}

function Stop-ChromeProcesses {
  Write-Host "Stopping Chrome and ClockBot processes..."
  Stop-Process -Name chrome,ClockBot,electron -ErrorAction SilentlyContinue

  $deadline = (Get-Date).AddSeconds(10)
  do {
    $remaining = Get-Process chrome -ErrorAction SilentlyContinue
    if (-not $remaining) {
      return
    }

    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  $stillRunning = (Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) -join ", "
  throw "Chrome processes are still running after waiting: $stillRunning"
}

$ErrorActionPreference = "Stop"
$sourceRoot = Normalize-Path (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data")
$sourceProfile = Join-Path $sourceRoot "Default"
$sourceLocalState = Join-Path $sourceRoot "Local State"
$targetRoot = $null

if (-not (Test-IsAdministrator)) {
  throw "Please run this script from an elevated PowerShell window (Run as Administrator)."
}

if (-not (Test-Path -LiteralPath $sourceProfile -PathType Container)) {
  throw "Chrome Default profile not found: $sourceProfile"
}

if (-not (Test-Path -LiteralPath $sourceLocalState -PathType Leaf)) {
  throw "Chrome Local State not found: $sourceLocalState"
}

Write-Host "Using Chrome source profile: $sourceProfile"
Stop-ChromeProcesses

$targetCandidates = Get-TargetProfileRoot
$targetPreparationErrors = @()

foreach ($candidate in $targetCandidates) {
  $resolvedCandidate = Normalize-Path $candidate

  if (-not (Test-ProfileDirectoryUsable $resolvedCandidate)) {
    $targetPreparationErrors += "Skipped unusable profile directory: $resolvedCandidate"
    continue
  }

  try {
    Write-Host "Preparing ClockBot target profile: $resolvedCandidate"
    Clear-TargetProfileRoot $resolvedCandidate
    $targetRoot = $resolvedCandidate
    break
  }
  catch {
    $targetPreparationErrors += "Failed to clear ${resolvedCandidate}: $($_.Exception.Message)"
  }
}

if (-not $targetRoot) {
  $details = $targetPreparationErrors -join [Environment]::NewLine
  throw "Could not prepare a writable ClockBot Playwright profile directory.`n$details"
}

$targetDefault = Join-Path $targetRoot "Default"
Write-Host "Using ClockBot target profile: $targetRoot"
Copy-Item -LiteralPath $sourceLocalState -Destination (Join-Path $targetRoot "Local State") -Force

$robocopyArgs = @(
  $sourceProfile,
  $targetDefault,
  "/MIR",
  "/B",
  "/R:0",
  "/W:0",
  "/XJ",
  "/XD",
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "AutofillAiModelCache",
  "WebStorage",
  "Accounts\Avatar Images",
  "/XF",
  "LOCK",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "Current Tabs",
  "Current Session",
  "Current App Session",
  "Current App Tabs",
  "Last Tabs",
  "Last Session",
  "Last App Session",
  "Last App Tabs"
)

Write-Host "Mirroring Chrome Default profile into ClockBot..."
& robocopy @robocopyArgs | Out-Host
$robocopyExitCode = $LASTEXITCODE

if ($robocopyExitCode -gt 7) {
  throw "robocopy failed with exit code $robocopyExitCode"
}

Write-Host ""
Write-Host "ClockBot Playwright profile is ready."
Write-Host "Target: $targetRoot"
