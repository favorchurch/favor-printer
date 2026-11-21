# Windows local dev signing (DEV ONLY)

For controlled local testing of the Windows installer (issue #42). This is **not** a release path and the
result is **not** a publicly trusted signature. A self-signed certificate says nothing about publisher
identity, will not satisfy a CA-trust check, and can still be blocked by Smart App Control. Never describe
a build made this way as released, verified or production ready.

Releases stay as in [RELEASING.md](RELEASING.md): nothing here publishes, tags, uploads or changes
`electron-builder.yml`, which carries no signing identity.

## What it does

| Piece | Purpose |
| --- | --- |
| `scripts/dev-signing/New-DevSigningCert.ps1` | Creates (or reuses) `CN=Favor Printer DEV ONLY`: RSA 3072, SHA-256, Code Signing EKU, **non-exportable** key, 30 days, in `CurrentUser\My`. Changes no trust store. |
| `electron-builder.dev-signed.yml` | `extends` the production config; sets only Windows signing. The thumbprint comes from `FAVOR_DEV_SIGN_SHA1`, never from a file. Artifacts are named `...-DEV-SIGNED-LOCAL.exe`. |
| `scripts/dev-signing/sign.mjs` | electron-builder `sign` hook: SDK `signtool sign /sha1 <thumbprint> /s My /fd sha256`. No timestamp, no key export. |
| `scripts/dev-signing/Build-DevSigned.ps1` | Finds the certificate and the SDK `signtool.exe`, exports them to the process environment only, runs `pnpm build` and `electron-builder --win nsis --x64 --publish never`. |
| `scripts/dev-signing/Verify-DevSigned.ps1` | `Get-AuthenticodeSignature` and `signtool verify /pa /v` per file; fails on a different thumbprint or any status other than `Valid` or `UnknownError` (only `Valid` with `-ExpectTrusted`). |
| `scripts/dev-signing/Remove-DevSigningCert.ps1` | Removes only the certificate with this exact subject, from CurrentUser `TrustedPublisher`, `My` and `Root`, in that order. |

electron-builder 26.15.3 signs the packaged app executable, `resources\elevate.exe`, the NSIS uninstaller
and the NSIS installer. The `.blockmap` and the update manifest are produced after signing. Always take the
SHA-256, sha512 and size from the final files, never from an earlier build.

## Use

Run the `.ps1` scripts from a PowerShell 7 (`pwsh`) session. Windows PowerShell 5.1 under its default
`Restricted` policy refuses to run them; use `powershell -File <script>` only where the existing policy
already allows scripts. Do not change the execution policy and do not use `Bypass` for this.

```powershell
# one-time: Windows SDK signing tools (SignTool)
winget install --id Microsoft.WindowsSDK.10.0.26100 --source winget --exact

scripts\dev-signing\New-DevSigningCert.ps1
scripts\dev-signing\Build-DevSigned.ps1            # output in release\

$t = (Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object Subject -eq 'CN=Favor Printer DEV ONLY').Thumbprint
scripts\dev-signing\Verify-DevSigned.ps1 -ExpectedThumbprint $t -Path (Resolve-Path release\Favor-Printer-*-DEV-SIGNED-LOCAL.exe), (Resolve-Path 'release\win-unpacked\Favor Printer.exe')
node scripts\verify-windows-release.mjs --dir release --channel <latest|beta> --version <version>
```

## Expected results

- **Before trust:** `Get-AuthenticodeSignature` reports `UnknownError` and `signtool verify /pa` reports
  "A certificate chain processed, but terminated in a root certificate which is not trusted". The subject and
  thumbprint are present, so the file is signed, not `NotSigned`. This is the correct outcome on any machine
  that has not trusted the certificate, including other profiles on this PC.
- **After trust (optional, operator or IT permission only):** `Valid`, in that profile only.

Trusting the certificate is a deliberate, separate step on the disposable test profile only:

```powershell
# public part only, current user only; never LocalMachine, never another device
$c = Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -eq 'CN=Favor Printer DEV ONLY'
Export-Certificate -Cert $c -FilePath "$env:TEMP\favor-dev-only.cer" | Out-Null
Import-Certificate -FilePath "$env:TEMP\favor-dev-only.cer" -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
Import-Certificate -FilePath "$env:TEMP\favor-dev-only.cer" -CertStoreLocation Cert:\CurrentUser\Root   # prompts for confirmation
```

While the certificate is trusted in `Root` or `TrustedPublisher`, any process running as this user can sign
files with its key that this profile then accepts as `Valid`, including updates and scripts under an
`AllSigned` policy. Run `Remove-DevSigningCert.ps1` as soon as testing ends.

Record which stores you changed. Root is only needed to make the chain `Valid`; `TrustedPublisher` alone does
not make a self-signed chain valid.

## Cleanup

```powershell
scripts\dev-signing\Remove-DevSigningCert.ps1 -WhatIf   # preview
scripts\dev-signing\Remove-DevSigningCert.ps1           # removes the key and every copy listed above
```

It matches the exact subject, so unrelated certificates are untouched. It removes the `TrustedPublisher` copy
first and the `Root` copy last. If you decline the Windows confirmation for `Root`, it reports the copy it
could not remove, finishes the rest and exits 1; run it again to remove that copy.

Then finish the cleanup:

- Uninstall the dev-signed Favor Printer from Settings > Apps.
- Delete the `.cer` temp file (`$env:TEMP\favor-dev-only.cer`).
- Delete the dev build output: every `release\*-DEV-SIGNED-LOCAL*` file and `release\latest.yml`, so neither
  can be mistaken for a release artifact.

## Limits

- A dev-signed install writes `publisherName: Favor Printer DEV ONLY` into its `app-update.yml` and still
  checks the real GitHub release feed. electron-updater then refuses every real release, including the
  unsigned `-beta` previews, and reports update errors on each check. The only fix is to uninstall the dev
  build and reinstall from a real release.
- The app's updater keeps `verifyUpdateCodeSignature` on. A dev-signed install cannot validly update to a
  build signed by a different publisher, so a later CA-signed release needs an uninstall and reinstall of any
  dev-signed pilot. Do not weaken that check to make the transition work.
- `.ps1` print helpers are not covered by this signature. Their execution follows the existing PowerShell
  policy and the installer's consent step.
- The certificate is for one test profile. Do not install it machine-wide or on other devices without IT
  approval, and never export, commit or share the private key (it is non-exportable by design).
