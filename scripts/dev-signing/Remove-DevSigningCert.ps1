<#
.SYNOPSIS
  Remove ONLY the "Favor Printer DEV ONLY" certificate (and its private key) from the current user.

.DESCRIPTION
  Deletes certificates whose subject is exactly -Subject from CurrentUser\My, CurrentUser\Root and
  CurrentUser\TrustedPublisher. Touches nothing else and never LocalMachine. Run it as the same user
  that created the certificate. Use -WhatIf to preview.
#>
[CmdletBinding(SupportsShouldProcess)]
param([string]$Subject = 'CN=Favor Printer DEV ONLY')
$ErrorActionPreference = 'Stop'
foreach ($store in 'My', 'Root', 'TrustedPublisher') {
  Get-ChildItem "Cert:\CurrentUser\$store" | Where-Object { $_.Subject -eq $Subject } | ForEach-Object {
    if ($PSCmdlet.ShouldProcess("CurrentUser\$store $($_.Thumbprint)", 'Remove DEV ONLY certificate')) {
      Remove-Item -LiteralPath $_.PSPath -DeleteKey
      "removed CurrentUser\$store $($_.Thumbprint)"
    }
  }
}
