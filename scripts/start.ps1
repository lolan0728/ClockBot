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

function Get-NodeBinary {
  $candidate = Join-Path $env:ProgramFiles "nodejs\node.exe"

  if (Test-Path $candidate) {
    return $candidate
  }

  throw "Could not find node.exe under Program Files."
}

$nodeBinary = Get-NodeBinary
$npmCli = Join-Path (Split-Path $nodeBinary -Parent) "node_modules\npm\bin\npm-cli.js"
$projectRoot = Normalize-Path (Join-Path $PSScriptRoot "..")
$env:npm_config_registry = "https://registry.npmjs.org/"
$env:npm_config_cache = Join-Path $projectRoot ".npm-cache"

Write-Host "Starting ClockBot from $projectRoot"
Push-Location -LiteralPath $projectRoot

try {
  & $nodeBinary $npmCli start --prefix $projectRoot
}
finally {
  Pop-Location
}

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
