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

function Get-ScriptDirectory {
  $candidates = @(
    $PSScriptRoot,
    $(if ($PSCommandPath) { Split-Path -Parent $PSCommandPath }),
    $(if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path })
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    $normalized = Normalize-Path $candidate
    if ($normalized -and (Test-Path -LiteralPath $normalized)) {
      return $normalized
    }
  }

  throw "Could not determine the script directory."
}

function Get-NodeBinary {
  $candidate = Join-Path $env:ProgramFiles "nodejs\node.exe"

  if (Test-Path $candidate) {
    return $candidate
  }

  throw "Could not find node.exe under Program Files."
}

$nodeBinary = Get-NodeBinary
$npmCli = Join-Path (Split-Path $nodeBinary -Parent) "node_modules\npm\bin\npm-cli.js"
$scriptDirectory = Get-ScriptDirectory
$projectRoot = Normalize-Path (Join-Path $scriptDirectory "..")
$env:npm_config_registry = "https://registry.npmjs.org/"
$env:npm_config_cache = Join-Path $projectRoot ".npm-cache"

Write-Host "Installing dependencies in $projectRoot"
Push-Location -LiteralPath $projectRoot

try {
  & $nodeBinary $npmCli install --prefix $projectRoot
}
finally {
  Pop-Location
}

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
