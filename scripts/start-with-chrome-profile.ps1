$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "start-with-chrome-default-profile.ps1")
exit $LASTEXITCODE
