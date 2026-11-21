<#
.SYNOPSIS
  Verify the signatures on a LOCAL dev-signed build: the installer and every PE file it produced.

.DESCRIPTION
  Reports Get-AuthenticodeSignature status/subject/thumbprint and `signtool verify /pa /v` for each
  file. Before the DEV ONLY certificate is trusted the expected status is UnknownError/UntrustedRoot
  (chain ends in an untrusted root). Exits 1 if the thumbprint differs from -ExpectedThumbprint or the
  status is anything other than Valid or UnknownError (only Valid with -ExpectTrusted), so NotSigned
  and HashMismatch always fail.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string[]]$Path,
  [Parameter(Mandatory)][string]$ExpectedThumbprint,
  [switch]$ExpectTrusted
)
$ErrorActionPreference = 'Stop'
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
  Sort-Object FullName | Select-Object -Last 1
$failed = $false
$allowed = if ($ExpectTrusted) { @('Valid') } else { @('Valid', 'UnknownError') }
foreach ($file in $Path) {
  $sig = Get-AuthenticodeSignature -FilePath $file
  $thumb = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { $null }
  $digest = if ($sig.SignerCertificate) { $sig.SignerCertificate.SignatureAlgorithm.FriendlyName } else { $null }
  "{0}`n  status={1} subject={2} thumbprint={3} certSigAlg={4}" -f (Split-Path $file -Leaf), $sig.Status, $sig.SignerCertificate.Subject, $thumb, $digest
  # signtool writes its verdict to stderr; an untrusted root is an expected, non-fatal outcome here.
  $ErrorActionPreference = 'Continue'
  $out = & $signtool.FullName verify /pa /v $file 2>&1 | ForEach-Object { "$_" } | Out-String
  $ErrorActionPreference = 'Stop'
  ($out -split "`r?`n" | Where-Object { $_ -match 'Hash of file|Signing Certificate Chain|Issued to|Number of|Successfully|SignTool Error|chain' }) | ForEach-Object { "  signtool: $_" }
  if ($thumb -ne $ExpectedThumbprint) { $failed = $true; "  FAIL: not signed by the expected certificate" }
  if ("$($sig.Status)" -notin $allowed) { $failed = $true; "  FAIL: status $($sig.Status), allowed: $($allowed -join ', ')" }
}
if ($failed) { exit 1 }
exit 0
