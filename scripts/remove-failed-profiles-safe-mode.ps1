param(
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

function Write-Status {
  param([string]$Message)
  Write-Host ('[ClockBot Cleanup] ' + $Message)
}

function Ensure-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run this script from an elevated PowerShell window (Run as Administrator).'
  }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativePrivilege {
  [StructLayout(LayoutKind.Sequential)]
  public struct LUID {
    public uint LowPart;
    public int HighPart;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct TOKEN_PRIVILEGES {
    public uint PrivilegeCount;
    public LUID Luid;
    public uint Attributes;
  }

  public const uint TOKEN_ADJUST_PRIVILEGES = 0x20;
  public const uint TOKEN_QUERY = 0x8;
  public const uint SE_PRIVILEGE_ENABLED = 0x2;

  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool AdjustTokenPrivileges(
    IntPtr TokenHandle,
    bool DisableAllPrivileges,
    ref TOKEN_PRIVILEGES NewState,
    int BufferLength,
    IntPtr PreviousState,
    IntPtr ReturnLength
  );

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
"@

function Enable-Privilege {
  param([string]$Name)

  $proc = [System.Diagnostics.Process]::GetCurrentProcess()
  $token = [IntPtr]::Zero

  if (-not [NativePrivilege]::OpenProcessToken(
    $proc.Handle,
    [NativePrivilege]::TOKEN_ADJUST_PRIVILEGES -bor [NativePrivilege]::TOKEN_QUERY,
    [ref]$token
  )) {
    throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
  }

  try {
    $luid = New-Object NativePrivilege+LUID
    if (-not [NativePrivilege]::LookupPrivilegeValue($null, $Name, [ref]$luid)) {
      throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }

    $tp = New-Object NativePrivilege+TOKEN_PRIVILEGES
    $tp.PrivilegeCount = 1
    $tp.Luid = $luid
    $tp.Attributes = [NativePrivilege]::SE_PRIVILEGE_ENABLED

    [void][NativePrivilege]::AdjustTokenPrivileges($token, $false, [ref]$tp, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($lastError -ne 0) {
      throw (New-Object ComponentModel.Win32Exception($lastError))
    }
  } finally {
    [void][NativePrivilege]::CloseHandle($token)
  }
}

function Invoke-Cmd {
  param(
    [string[]]$Arguments
  )

  $stdout = [System.IO.Path]::GetTempFileName()
  $stderr = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath 'cmd.exe' `
      -ArgumentList @('/c', ($Arguments -join ' ')) `
      -Wait `
      -PassThru `
      -NoNewWindow `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr

    $output = @()
    if (Test-Path -LiteralPath $stdout) {
      $output += Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stderr) {
      $output += Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue
    }

    [pscustomobject]@{
      ExitCode = $process.ExitCode
      Output = $output
    }
  } finally {
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Robocopy {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$Arguments
  )

  $stdout = [System.IO.Path]::GetTempFileName()
  $stderr = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath 'robocopy.exe' `
      -ArgumentList (@($Source, $Destination) + $Arguments) `
      -Wait `
      -PassThru `
      -NoNewWindow `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr

    $output = @()
    if (Test-Path -LiteralPath $stdout) {
      $output += Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stderr) {
      $output += Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue
    }

    [pscustomobject]@{
      ExitCode = $process.ExitCode
      Output = $output
    }
  } finally {
    Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
  }
}

function Write-CommandOutput {
  param(
    [string]$Prefix,
    [object]$Result
  )

  if ($null -eq $Result -or $null -eq $Result.Output) {
    return
  }

  foreach ($line in $Result.Output) {
    if (-not [string]::IsNullOrWhiteSpace($line)) {
      Write-Status ($Prefix + $line)
    }
  }
}

function Clear-Target {
  param(
    [string]$Path,
    [string]$ClockBotRoot,
    [string]$EmptyDir
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Status ("Already missing: " + $Path)
    return
  }

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullRoot = [System.IO.Path]::GetFullPath($ClockBotRoot)
  if (-not $fullPath.StartsWith($fullRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw ("Refusing to touch path outside ClockBot root: " + $fullPath)
  }

  Write-Status ("Cleaning: " + $fullPath)

  $junctionPath = Join-Path $fullPath 'Default'
  if (Test-Path -LiteralPath $junctionPath) {
    try {
      $item = Get-Item -LiteralPath $junctionPath -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Write-Status ("Trying to remove junction first: " + $junctionPath)
        $result = Invoke-Cmd @('rmdir', ('"' + $junctionPath + '"'))
        Write-CommandOutput -Prefix 'rmdir: ' -Result $result
      }
    } catch {
      Write-Status ("Junction probe failed: " + $_.Exception.Message)
    }
  }

  Write-Status 'Taking ownership...'
  $result = Invoke-Cmd @('takeown', '/f', ('"' + $fullPath + '"'), '/r', '/d', 'y')
  Write-CommandOutput -Prefix 'takeown: ' -Result $result

  Write-Status 'Resetting ACLs...'
  $result = Invoke-Cmd @('icacls', ('"' + $fullPath + '"'), '/grant', ('"' + $env:USERNAME + ':(OI)(CI)F"'), '/t', '/c')
  Write-CommandOutput -Prefix 'icacls(user): ' -Result $result
  $result = Invoke-Cmd @('icacls', ('"' + $fullPath + '"'), '/grant', '"Administrators:(OI)(CI)F"', '/t', '/c')
  Write-CommandOutput -Prefix 'icacls(admin): ' -Result $result

  Write-Status 'Clearing file attributes...'
  $result = Invoke-Cmd @('attrib', '-r', '-s', '-h', ('"' + $fullPath + '"'), '/s', '/d')
  Write-CommandOutput -Prefix 'attrib: ' -Result $result

  Write-Status 'Mirroring from an empty directory...'
  $result = Invoke-Robocopy -Source $EmptyDir -Destination $fullPath -Arguments @('/MIR', '/B', '/R:0', '/W:0', '/XJ')
  Write-CommandOutput -Prefix 'robocopy: ' -Result $result

  Write-Status 'Trying recursive delete...'
  $result = Invoke-Cmd @('rd', '/s', '/q', ('"' + $fullPath + '"'))
  Write-CommandOutput -Prefix 'rd: ' -Result $result

  if (Test-Path -LiteralPath $fullPath) {
    try {
      Remove-Item -LiteralPath $fullPath -Recurse -Force -ErrorAction Stop
    } catch {
      Write-Status ("Remove-Item still failed: " + $_.Exception.Message)
    }
  }

  if (Test-Path -LiteralPath $fullPath) {
    throw ("Still exists after cleanup attempts: " + $fullPath + '. Run this script from Windows Safe Mode for the highest chance of removal.')
  }

  Write-Status ("Removed: " + $fullPath)
}

Ensure-Administrator

Write-Status 'Enabling backup and restore privileges...'
foreach ($privilege in 'SeBackupPrivilege', 'SeRestorePrivilege', 'SeTakeOwnershipPrivilege', 'SeSecurityPrivilege') {
  Enable-Privilege -Name $privilege
}

$clockBotRoot = Join-Path $env:APPDATA 'ClockBot'
$emptyDir = Join-Path $env:TEMP 'clockbot-empty-dir'
$logPath = Join-Path $env:USERPROFILE 'Desktop\ClockBot-删除日志.txt'

if (-not (Test-Path -LiteralPath $clockBotRoot)) {
  throw ('ClockBot root not found: ' + $clockBotRoot)
}

if (-not (Test-Path -LiteralPath $emptyDir)) {
  New-Item -ItemType Directory -Path $emptyDir | Out-Null
}

$targets = @(
  (Join-Path $clockBotRoot 'chrome-default-wrapper-test'),
  (Join-Path $clockBotRoot 'automation-profile')
)

Start-Transcript -Path $logPath -Force | Out-Null

try {
  Write-Status 'Stopping related processes...'
  Stop-Process -Name chrome, ClockBot, electron, msedge -ErrorAction SilentlyContinue

  Write-Status 'This script is intended for Safe Mode or the cleanest possible admin session.'
  Write-Status 'It will only remove failed ClockBot profile leftovers and will not touch chrome-default-wrapper.'

  foreach ($target in $targets) {
    Clear-Target -Path $target -ClockBotRoot $clockBotRoot -EmptyDir $emptyDir
  }

  Write-Status 'Cleanup completed successfully.'
} catch {
  Write-Status ('Cleanup stopped: ' + $_.Exception.Message)
  Write-Status ('See log: ' + $logPath)
  throw
} finally {
  Stop-Transcript | Out-Null
  if (-not $NoPause) {
    Write-Host ''
    Read-Host 'Press Enter to exit'
  }
}
