# Windows USB Zebra RAW/ZPL transport (experimental)

**Tracking:** [Favor Printer issue #42](https://github.com/favorchurch/favor-printer/issues/42), [RSVP relay PR #1002](https://github.com/favorchurch/rsvp.favor.church/pull/1002), [Favor Printer PR #75](https://github.com/favorchurch/favor-printer/pull/75).

**Status:** Transport foundation only. The Electron app is still macOS/CUPS-only. There is NO working or signed Windows installer yet.

## Architecture

- Windows discovery uses the read-only CIM probe. PnP selection hints, USB001 ports and queue names are **not** verified physical USB serials or cloud printer UUIDs.
- The canonical RSVP relay has a Windows transport with exactly one configured cloud printer UUID per local USB queue.
- The native PowerShell 5.1 Winspool helper submits ZPL bytes as RAW through stdin, without interpolating them in shell commands or logging attendee information.
- A definite process spawn failure before the persisted sending gate is unsent; after the gate an uncertain result is ambiguous and never automatically retried.
- A clean spool acknowledgement means the Windows Spooler accepted the job, **not that a physical label printed**. Probe can verify a local queue opens, but status stays unknown.
- The vendored relay was generated using RSVP's official sync script, pinned to canonical commit 2262d3f94a9d2fc1ae0f790c5cf985821b9413cd. Never hand-edit these vendored runtime files.

## Remaining blockers

1. Verify actual Zebra ZD421 hardware serial on a Windows PC independently of queue, port and PnP instance; fail closed when missing. Implement proper device binding and secure RSVP OTP enrollment, with campus scoping and no duplicate cloud printer.
2. Integrate Windows printer discovery/transport into the Electron main process, platform-specific app data and secure credentials. Keep macOS CUPS behavior unchanged.
3. Install the fixed helper from a trusted local app resource; keep approved PowerShell execution policy. Package and sign Windows installer, startup/update/uninstall/re-enrollment lifecycle.
4. With non-production credentials, physically print a cloud-routed test and Kids parent/child labels; test unplug/replug, restart, queued/ambiguous jobs, revocation, no duplicates and macOS regression.
5. Independent exact-SHA review and CI/release approval before merging. PRs remain draft.

## Offline evidence — October 28, 2026

Favor Printer sandbox: 24 focused Windows discovery/transport tests passed; full 48-file suite 1,181 pass, 2 existing skips. Lint, typecheck, build and vendored-manifest verification passed.

**Not verified:** real Windows PowerShell, Winspool P/Invoke, physical Zebra, signing/installer, end-to-end cloud enrollment or production deployment.
