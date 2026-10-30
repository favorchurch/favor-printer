# Windows USB Zebra RAW/ZPL transport (experimental)

**Tracking:** [Favor Printer issue #42](https://github.com/favorchurch/favor-printer/issues/42), [RSVP relay PR #1002](https://github.com/favorchurch/rsvp.favor.church/pull/1002), [Favor Printer PR #75](https://github.com/favorchurch/favor-printer/pull/75).

**Status:** Windows Electron host integration and unsigned NSIS configuration implemented on draft Favor Printer PR #75, pending verified Windows-native packaging, serial discovery and physical Zebra acceptance. There is NO signed or released Windows installer yet.

## Architecture

- Windows discovery uses the read-only CIM probe. PnP selection hints, USB001 ports and queue names are **not** verified physical USB serials or cloud printer UUIDs.
- The canonical RSVP relay has a Windows transport with exactly one configured cloud printer UUID per local USB queue.
- The native PowerShell 5.1 Winspool helper submits ZPL bytes as RAW through stdin, without interpolating them in shell commands or logging attendee information.
- A definite process spawn failure before the persisted sending gate is unsent; after the gate an uncertain result is ambiguous and never automatically retried.
- A clean spool acknowledgement means the Windows Spooler accepted the job, **not that a physical label printed**. Probe can verify a local queue opens, but status stays unknown.
- The vendored relay was generated using RSVP's official sync script, pinned to canonical commit 136a9fe876b3b60ff73fbfabeabb4ce69a3abde5 (RSVP PR #1002). Never hand-edit these vendored runtime files.

## Remaining blockers

1. Validate the new fail-closed Windows `Get-PnpDevice` unique-USB-parent serial evidence against actual ZD421 hardware. It rejects queue names/ports/ambiguous PnP fragments and only enrolls a uniquely verified device; review actual Windows-driver behavior and repair only with evidence.
2. Independently validate the newly wired Electron service, platform-specific AppData and `safeStorage` credentials on a real Windows system. Mac CUPS paths are unchanged.
3. Confirm the fixed PowerShell scripts are packaged as immutable app `extraResources` (the release job now byte-compares them), execute under approved PowerShell policy (installer consent or IT policy), and verify NSIS installer/startup/update/uninstall/re-enrollment. A Windows code-signing certificate is required before production, and in practice before any Windows 11 PC with Smart App Control can run the app at all.
4. With non-production credentials, physically print a cloud-routed test and Kids parent/child labels; test unplug/replug, restart, queued/ambiguous jobs, revocation, no duplicates and macOS regression. See [hands-on acceptance guide](WINDOWS-HARDWARE-ACCEPTANCE.md).
5. Independent exact-SHA review and CI/release approval before merging. PRs remain draft.

## Windows-native evidence — October 30, 2026

Windows 11 Home x64 (build 26200), standard (non-admin) user, Node 24.14, pnpm 10.28.0, **no printer attached**, Smart App Control **enforcing**, `LocalMachine` execution policy `Restricted` (stock).

- Frozen install, `verify:vendor`, lint, typecheck: pass. `pnpm test`: 50 files, 1,200 passed, 2 existing skips (after making 8 macOS-path/POSIX-mode tests portable and enabling `shell-emulator` so the POSIX env prefix in `pnpm test` runs on Windows).
- Relay vendored from RSVP `136a9fe8` (PR #1002 merged with RSVP main / #1036 CUPS batching; Windows keeps the per-label path). Helper exits proven to precede `StartDocPrinter` (codes 2-5 with their exact marker, or the execution-policy refusal) are now **unsent**; everything else after the sending gate stays **ambiguous**.
- **Fixed:** the USB-parent serial regex in `probe-printers.ps1` threw `Unrecognized escape sequence \V` on real PowerShell 5.1, so no Zebra could ever have been enrolled. Verified the corrected pattern extracts `USB\VID_0A5F&PID_xxxx\<serial>`.
- **Found:** under stock `Restricted` policy, `powershell.exe -File` refuses both helpers. The probe now fails closed as `policy-blocked` (no phantom device, no OTP enrollment, relay stays stopped) with an operator warning. The installer asks consent to set CurrentUser `RemoteSigned` (see [RELEASING.md](RELEASING.md#windows-printer-host-preview)).
- Probe with policy permitting it: valid JSON, only virtual queues (OneNote, Print to PDF), **zero Zebra candidates** — the expected result on this PC.
- **Blocked here:** Smart App Control blocked the unsigned NSIS build step and `Favor Printer.exe` itself ("An Application Control policy has blocked this file"). Tray, AppData, safeStorage, startup-at-login, Printers & scanners link, install/uninstall/update could not be exercised on this PC. They need a signed build, or a Windows PC without Smart App Control enforcement.

## Offline evidence — October 28, 2026

Favor Printer sandbox: 24 focused Windows discovery/transport tests passed; full 48-file suite 1,181 pass, 2 existing skips. Lint, typecheck, build and vendored-manifest verification passed.

**Not verified:** real Windows PowerShell, Winspool P/Invoke, physical Zebra, signing/installer, end-to-end cloud enrollment or production deployment.
