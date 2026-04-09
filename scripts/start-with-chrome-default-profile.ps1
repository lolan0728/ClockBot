$ErrorActionPreference = "Stop"
$chromeUserDataRoot = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
$chromeLocalState = Join-Path $chromeUserDataRoot "Local State"
$wrapperRoot = Join-Path $env:APPDATA "ClockBot\chrome-default-wrapper"

function Get-ChromeProfileDirectoryName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LocalStatePath
  )

  try {
    $localState = Get-Content -LiteralPath $LocalStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $lastUsed = [string]$localState.profile.last_used
    if (-not [string]::IsNullOrWhiteSpace($lastUsed)) {
      return $lastUsed.Trim()
    }
  }
  catch {
    Write-Warning "Could not parse Chrome Local State. Falling back to Default. $($_.Exception.Message)"
  }

  return "Default"
}

if (-not (Test-Path -LiteralPath $chromeUserDataRoot -PathType Container)) {
  throw "Chrome user data root not found: $chromeUserDataRoot"
}

if (-not (Test-Path -LiteralPath $chromeLocalState -PathType Leaf)) {
  throw "Chrome Local State not found: $chromeLocalState"
}

$chromeProfileDirectoryName = Get-ChromeProfileDirectoryName -LocalStatePath $chromeLocalState
$chromeProfilePath = Join-Path $chromeUserDataRoot $chromeProfileDirectoryName
$wrapperProfilePath = Join-Path $wrapperRoot $chromeProfileDirectoryName

if (-not (Test-Path -LiteralPath $chromeProfilePath -PathType Container)) {
  throw "Chrome profile not found: $chromeProfilePath"
}

Write-Host "Preparing wrapper profile root: $wrapperRoot"
Stop-Process -Name chrome,ClockBot,electron -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $wrapperRoot) {
  Get-ChildItem -LiteralPath $wrapperRoot -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
  }
}
else {
  New-Item -ItemType Directory -Path $wrapperRoot -Force | Out-Null
}

Copy-Item -LiteralPath $chromeLocalState -Destination (Join-Path $wrapperRoot "Local State") -Force
New-Item -ItemType Junction -Path $wrapperProfilePath -Target $chromeProfilePath | Out-Null

$env:CLOCKBOT_PLAYWRIGHT_PROFILE_DIR = $wrapperRoot
$env:CLOCKBOT_CHROME_PROFILE_DIRECTORY = $chromeProfileDirectoryName

Write-Host "ClockBot Playwright will use your Chrome profile through a wrapper root:"
Write-Host "  $chromeProfilePath"
Write-Host "Profile directory name:"
Write-Host "  $chromeProfileDirectoryName"
Write-Host "Wrapper root:"
Write-Host "  $wrapperRoot"
Write-Host ""
Write-Host "Please keep Chrome fully closed while using Playwright mode."
Write-Host ""

& (Join-Path $PSScriptRoot "start.ps1")
exit $LASTEXITCODE
