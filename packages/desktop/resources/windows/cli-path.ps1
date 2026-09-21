param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Uninstall", "Status", "TransformInstall", "TransformUninstall")]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$OwnedPath,
  [string]$CliPath,
  [AllowEmptyString()]
  [string]$PathValue = ""
)

$ErrorActionPreference = "Stop"

function Normalize-PathEntry([string]$Entry) {
  $value = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"')).Replace('/', '\')
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  try { $value = [IO.Path]::GetFullPath($value) } catch { }
  $root = [IO.Path]::GetPathRoot($value)
  while ($value.Length -gt $root.Length -and $value.EndsWith('\')) { $value = $value.Substring(0, $value.Length - 1) }
  return $value.ToUpperInvariant()
}

function Transform-Path([string]$Value, [string]$Owned, [bool]$Install) {
  $normalized = Normalize-PathEntry $Owned
  if ([string]::IsNullOrWhiteSpace($normalized)) { throw "The CookieMonster CLI directory is invalid." }
  $entries = if ($Value.Length -eq 0) { @() } else { @($Value.Split([char]';')) }
  $found = $false
  $result = @($entries | ForEach-Object {
    if ((Normalize-PathEntry $_) -ne $normalized) { return $_ }
    if ($Install -and -not $found) {
      $found = $true
      return $Owned
    }
  })
  if ($Install -and -not $found) { return (@($Owned) + $result) -join ';' }
  return $result -join ';'
}

function Read-UserPath {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
  try {
    if ($null -eq $key) { return $null }
    return $key.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {
    if ($null -ne $key) { $key.Dispose() }
  }
}

function Write-UserPath([AllowNull()][string]$Value) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment", $true)
  try {
    if ($null -eq $Value -or $Value.Length -eq 0) {
      $key.DeleteValue("Path", $false)
    } else {
      $key.SetValue("Path", $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    }
  } finally {
    $key.Dispose()
  }
  Send-EnvironmentChange
}

function Send-EnvironmentChange {
  if (-not ([System.Management.Automation.PSTypeName]'CookieMonster.EnvironmentChange').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CookieMonster {
public static class EnvironmentChange {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
}
'@
  }
  $result = [IntPtr]::Zero
  $broadcast = [CookieMonster.EnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [IntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
  if ($broadcast -eq [IntPtr]::Zero) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CookieMonster updated PATH, but could not notify running applications (Windows error $code). Restart your Windows session and rerun the installer."
  }
}

if ($Action -eq "TransformInstall") {
  Write-Output (Transform-Path $PathValue $OwnedPath $true)
  exit 0
}
if ($Action -eq "TransformUninstall") {
  Write-Output (Transform-Path $PathValue $OwnedPath $false)
  exit 0
}

$current = Read-UserPath
if ($Action -eq "Status") {
  $entries = if ($null -eq $current) { @() } else { $current.Split([char]';') }
  $registered = @($entries | Where-Object { (Normalize-PathEntry $_) -eq (Normalize-PathEntry $OwnedPath) }).Count -gt 0
  [pscustomobject]@{ registered = $registered; path = $OwnedPath } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "Install") {
  if ([string]::IsNullOrWhiteSpace($CliPath) -or -not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
    throw "The bundled CookieMonster CLI is missing."
  }
  $process = Start-Process -FilePath $CliPath -ArgumentList "--version" -NoNewWindow -PassThru
  if (-not $process.WaitForExit(30000)) {
    $process.Kill()
    throw "The bundled CookieMonster CLI validation timed out."
  }
  if ($process.ExitCode -ne 0) { throw "The bundled CookieMonster CLI failed validation." }
  Write-UserPath (Transform-Path $(if ($null -eq $current) { "" } else { [string]$current }) $OwnedPath $true)
  exit 0
}

if ($null -eq $current) { exit 0 }
Write-UserPath (Transform-Path ([string]$current) $OwnedPath $false)
