<#
.SYNOPSIS
  Create (or reuse) the short-lived, self-signed "Favor Printer DEV ONLY" code-signing certificate.

.DESCRIPTION
  Local, dev-only (issue #42). The private key is non-exportable and stays in CurrentUser\My.
  This script changes no trust store. Until you trust the public certificate yourself, signatures
  verify as UntrustedRoot, which is the expected outcome and proves the artifact is not NotSigned.
  Prints only public facts: subject, thumbprint, expiry.
#>
[CmdletBinding()]
param(
  [string]$Subject = 'CN=Favor Printer DEV ONLY',
  [int]$ValidDays = 30
)
$ErrorActionPreference = 'Stop'
$now = Get-Date
$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt $now.AddDays(1) -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending | Select-Object -First 1
if ($existing) { $cert = $existing; $state = 'reused' } else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable `
    -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -NotAfter $now.AddDays($ValidDays)
  $state = 'created'
}
$eku = ($cert.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId }) -join ','
[pscustomobject]@{
  State = $state; Subject = $cert.Subject; Thumbprint = $cert.Thumbprint
  NotAfter = $cert.NotAfter.ToString('s'); HasPrivateKey = $cert.HasPrivateKey
  CodeSigningEku = ($eku -match '1\.3\.6\.1\.5\.5\.7\.3\.3'); Store = 'CurrentUser\My'
} | Format-List
