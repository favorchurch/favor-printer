<#
.SYNOPSIS
  Build the LOCAL, DEV-ONLY signed Windows installer (issue #42). Never publishes.

.DESCRIPTION
  Finds the "Favor Printer DEV ONLY" certificate in CurrentUser\My and the Windows SDK signtool.exe,
  passes both to electron-builder through the process environment only, then runs
  `pnpm build` and `electron-builder --win nsis --x64 --publish never` with
  electron-builder.dev-signed.yml. Run New-DevSigningCert.ps1 first.
#>
[CmdletBinding()]
param([string]$Subject = 'CN=Favor Printer DEV ONLY')
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) { throw "No valid DEV ONLY certificate in CurrentUser\My. Run scripts\dev-signing\New-DevSigningCert.ps1." }
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1
if (-not $signtool) { throw 'signtool.exe not found. Install the Windows SDK signing tools (winget install Microsoft.WindowsSDK.10.0.26100).' }
$env:FAVOR_DEV_SIGN_SHA1 = $cert.Thumbprint
$env:FAVOR_DEV_SIGNTOOL = $signtool.FullName
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
Push-Location $root
try {
  pnpm.cmd build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed ($LASTEXITCODE)" }
  pnpm.cmd exec electron-builder --win nsis --x64 --publish never --config electron-builder.dev-signed.yml
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
} finally { Pop-Location }
