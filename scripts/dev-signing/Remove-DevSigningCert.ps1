<#
.SYNOPSIS
  Remove ONLY the "Favor Printer DEV ONLY" certificate (and its private key) from the current user.

.DESCRIPTION
  Deletes certificates whose subject is exactly -Subject from CurrentUser\TrustedPublisher,
  CurrentUser\My and CurrentUser\Root, in that order. Root is last because Windows asks to confirm
  that removal; a failed or declined removal is reported and the script carries on, then exits 1.
  Touches nothing else and never LocalMachine. Run it as the same user
  that created the certificate. Use -WhatIf to preview.
#>
[CmdletBinding(SupportsShouldProcess)]
param([string]$Subject = 'CN=Favor Printer DEV ONLY')
$ErrorActionPreference = 'Stop'
$failed = $false
foreach ($store in 'TrustedPublisher', 'My', 'Root') {
  Get-ChildItem "Cert:\CurrentUser\$store" | Where-Object { $_.Subject -eq $Subject } | ForEach-Object {
    $cert = $_
    if ($PSCmdlet.ShouldProcess("CurrentUser\$store $($cert.Thumbprint)", 'Remove DEV ONLY certificate')) {
      try {
        Remove-Item -LiteralPath $cert.PSPath -DeleteKey
        "removed CurrentUser\$store $($cert.Thumbprint)"
      } catch {
        $failed = $true
        Write-Warning "NOT removed CurrentUser\$store $($cert.Thumbprint): $($_.Exception.Message). Run this script again."
      }
    }
  }
}
if ($failed) { exit 1 }
