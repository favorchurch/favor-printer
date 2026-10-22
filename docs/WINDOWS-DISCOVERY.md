# Windows discovery foundation — issue #42

This is a **partial, read-only foundation**, not a Windows Favor Printer release.
The app still starts its existing macOS CUPS service. Nothing in this change is
wired into enrollment, the relay, the renderer, installers, or automatic updates.

## What is implemented

`scripts/windows/probe-printers.ps1` collects local `Win32_Printer` observations
through `Get-CimInstance`. It neither creates a queue nor installs a driver,
submits a job, changes a service, reads print-job contents, or changes credentials.
It emits a versioned JSON contract, including the empty-array case. Errors exit
nonzero rather than pretending no printers exist.

`windowsDiscovery.ts` parses that contract and exposes an injected-command
boundary for later Windows integration. It identifies Zebra candidates, records
spooler status separately from physical readiness, and refuses ambiguous local
selection when a queue is networked, not USB, duplicated, missing a recognized
PnP instance, or malformed. No queue name or port is used as an identity fallback.

The normalized `windows-pnp:` selection key identifies a **local Windows device
instance**. It is not the canonical cloud printer UUID, a proven hardware serial,
or a promise that Windows will preserve the instance after driver replacement.
Canonical cloud identity must continue to come from the shared RSVP OTP flow.
An instance change must require explicit reconciliation, never auto-create a
second cloud printer. An `available` queue status is not evidence that a physical
printer is plugged in or that paper was printed.

Some Windows drivers expose only `SWD/PRINTENUM`, no PnP identity, or unfamiliar
USB instance formats. These remain visible, blocked candidates. Capture the
actual observations and design a verified identity lookup before expanding the
allowlist; do not manufacture a serial from `USB001` or a queue label.

## Windows verification harness

On an authorized Windows test PC with the intended Zebra driver and ZD421, run
the read-only script from a source checkout using the machine's normal approved
PowerShell execution policy. Do not relax that policy to run the probe.

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File .\scripts\windows\probe-printers.ps1
```

Keep the output local: queue names and device instance identifiers can reveal
machine details. Before attaching a diagnostic fixture to GitHub, replace names
and instance suffixes with synthetic values while retaining structural fields.
The unit fixtures in the test file are synthetic; they are not captures from a
verified Windows/Zebra pairing.

Record the Windows release, Zebra model, installed driver/version, USB connection,
and whether the process used ordinary-user permissions. Check each state:

| Case | Expected safety result |
| --- | --- |
| No configured printers | Successful JSON with `printers: []` |
| One ZD421 on USB | Inspect its exact PnP and port fields; a recognized, unique local USB instance gets a local selection key |
| Printer unplugged / queue offline | Do not infer physical readiness from a stale spooler queue; compare observations before/after |
| Queue renamed / same device replugged | Compare actual instance IDs; never change the cloud UUID merely because a label or port changed |
| Two queues for one device | Both candidates blocked for duplicate hardware identity |
| Network, shared, pooled, or file queue | No local USB selection |
| Driver missing or only SWD identity | Visible blocked candidate; no guess or auto-enrollment |
| CIM permission/provider failure | Nonzero probe exit; no false empty inventory |

After collecting a sanitized real fixture, run the repository's existing Vitest
suite on Windows as well as the probe. The Linux tests only validate the parser,
policy, and argument boundary; they do not execute PowerShell or Windows CIM.

## Verification recorded for this patch

On the Linux development runner with Node 24.19.0 and the repository's pinned
pnpm 10.28.0, a frozen install succeeded. `pnpm verify:vendor`, `pnpm lint`, and
`pnpm typecheck` passed. The complete `pnpm test` run passed **47 test files,
1,172 tests**, with **2 existing skipped tests**. This includes 15 new discovery
tests covering malformed and oversized observations, unknown or duplicate
identities, queue/port changes, network queues, status uncertainty, and the fixed
process argument boundary. `git diff --check` passed.

PowerShell, Windows CIM, Zebra drivers, physical printing, packaging, and signed
updates were not executed or verified here. The fixture matrix above remains a
required Windows gate before this foundation can be integrated into the app.

## Local continuation

1. Verify the above Windows/CIM fixture matrix and refine identity resolution
   using real evidence, including device unplug/replug and driver reinstall.
2. Add the Windows native RAW/ZPL print transport in **RSVP**, the canonical relay
   source, with explicit definitely-unsent versus ambiguous outcomes. Sync the
   official vendor bundle; never edit `vendor/relay` directly here.
3. Integrate a Windows printer service and platform selection without changing
   macOS CUPS behavior. Reuse OTP, campus, relay identity and canonical printer
   UUID contracts. Preserve ambiguous-job recovery and no-duplicate printing.
4. Implement Windows credential storage, app-data paths, signing/installer/update
   lifecycle, startup/uninstall handling, and actionable driver setup.
5. Verify physical RSVP parent/child labels, cloud tests, offline/backlog,
   revocation, restart, and ambiguous outcomes on Windows plus macOS regressions.
6. Have a separate agent review the final implementation and release plan. Keep
   the PR draft and #42 open until the required Windows acceptance is recorded.

Full-issue planning estimate: **55% ChatGPT / 45% Windows or service-owner work**.
This is an allocation estimate, not completion. This patch covers only discovery
contract scaffolding and its offline safety checks; transport, packaging and
hardware acceptance remain unfinished.
