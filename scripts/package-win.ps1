$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = (Resolve-Path $projectRoot).Path

Write-Host "Packaging ClockBot for Windows in $projectRoot"

$nodeExe = "C:\Program Files\nodejs\node.exe"
$npmCli = "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"

if (-not (Test-Path $nodeExe)) {
  throw "Node.exe was not found at $nodeExe"
}

if (-not (Test-Path $npmCli)) {
  throw "npm-cli.js was not found at $npmCli"
}

$packageJsonPath = Join-Path $projectRoot "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$productName = [string]$packageJson.productName
$version = [string]$packageJson.version
$distDir = Join-Path $projectRoot "dist"
$desiredZipName = "$productName-win-unpacked-$version.zip"
$projectRootPrefix = ($projectRoot.TrimEnd("\") + "\").ToLowerInvariant()
$assetsDir = Join-Path $projectRoot "src\assets"
$iconOutputPath = Join-Path $assetsDir "icon.ico"

function New-IcoFromPngs {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$SourceFiles,
    [Parameter(Mandatory = $true)]
    [string]$OutputFile
  )

  Add-Type -AssemblyName System.Drawing

  $loadedImages = @()
  foreach ($sourceFile in $SourceFiles) {
    if (-not (Test-Path $sourceFile)) {
      continue
    }

    $image = [System.Drawing.Image]::FromFile($sourceFile)
    $loadedImages += [PSCustomObject]@{
      Path = $sourceFile
      Image = $image
      Width = [int]$image.Width
      Height = [int]$image.Height
    }
  }

  if ($loadedImages.Count -eq 0) {
    throw "No PNG icon sources were found."
  }

  try {
    $master = $loadedImages | Sort-Object Width, Height -Descending | Select-Object -First 1
    $iconSizes = @(16, 24, 32, 48, 64, 128, 256)
    $entries = @()

    foreach ($size in $iconSizes) {
      $bitmap = New-Object System.Drawing.Bitmap $size, $size
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.Clear([System.Drawing.Color]::Transparent)
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
          $graphics.DrawImage($master.Image, 0, 0, $size, $size)
        } finally {
          $graphics.Dispose()
        }

        $memoryStream = New-Object System.IO.MemoryStream
        try {
          $bitmap.Save($memoryStream, [System.Drawing.Imaging.ImageFormat]::Png)
          $entries += [PSCustomObject]@{
            Width = $size
            Height = $size
            Bytes = $memoryStream.ToArray()
          }
        } finally {
          $memoryStream.Dispose()
        }
      } finally {
        $bitmap.Dispose()
      }
    }

    $orderedEntries = $entries | Sort-Object Width, Height
  $stream = [System.IO.File]::Open($OutputFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)

    try {
      $writer = New-Object System.IO.BinaryWriter($stream)
      $writer.Write([UInt16]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]$orderedEntries.Count)

      $offset = 6 + (16 * $orderedEntries.Count)
      foreach ($entry in $orderedEntries) {
        $widthByte = if ($entry.Width -ge 256) { 0 } else { [byte]$entry.Width }
        $heightByte = if ($entry.Height -ge 256) { 0 } else { [byte]$entry.Height }

        $writer.Write([byte]$widthByte)
        $writer.Write([byte]$heightByte)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$entry.Bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $entry.Bytes.Length
      }

      foreach ($entry in $orderedEntries) {
        $writer.Write($entry.Bytes)
      }

      $writer.Flush()
    } finally {
      $stream.Dispose()
    }
  } finally {
    foreach ($loadedImage in $loadedImages) {
      $loadedImage.Image.Dispose()
    }
  }
}

function Stop-BlockingClockBotProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProcessName,
    [Parameter(Mandatory = $true)]
    [string]$ProjectPrefix
  )

  $running = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
  if ($running.Count -eq 0) {
    return
  }

  $blocking = @()
  foreach ($process in $running) {
    $matchesProject = $false

    try {
      if ($process.Path) {
        $matchesProject = $process.Path.ToLowerInvariant().StartsWith($ProjectPrefix)
      }
    } catch {
      $matchesProject = $true
    }

    if ($matchesProject) {
      $blocking += $process
    }
  }

  if ($blocking.Count -eq 0) {
    return
  }

  Write-Host "Stopping running $ProcessName processes that would block packaging..."
  $blocking | Stop-Process -Force
  Start-Sleep -Milliseconds 1200
}

Push-Location $projectRoot
try {
  New-IcoFromPngs -SourceFiles @(
    (Join-Path $assetsDir "icon-64.png"),
    (Join-Path $assetsDir "icon-256.png")
  ) -OutputFile $iconOutputPath
  Stop-BlockingClockBotProcesses -ProcessName $productName -ProjectPrefix $projectRootPrefix
  $env:ELECTRON_CACHE = Join-Path $projectRoot ".electron-cache"
  $env:ELECTRON_BUILDER_CACHE = Join-Path $projectRoot ".electron-builder-cache"
  & $nodeExe $npmCli run pack:win
  if ($LASTEXITCODE -ne 0) {
    throw "Packaging failed with exit code $LASTEXITCODE"
  }

  $zipFiles = Get-ChildItem -Path $distDir -Filter *.zip -File -ErrorAction SilentlyContinue
  if ($zipFiles.Count -gt 0) {
    $preferredZip = $zipFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $targetZipPath = Join-Path $distDir $desiredZipName

    if ($preferredZip.FullName -ne $targetZipPath) {
      if (Test-Path $targetZipPath) {
        Remove-Item $targetZipPath -Force
      }

      Rename-Item -Path $preferredZip.FullName -NewName $desiredZipName
      Write-Host "Renamed zip artifact to $desiredZipName"
    }
  }
} finally {
  Pop-Location
}
