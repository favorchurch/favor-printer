# Windows discovery foundation — issue #42

This page documents the read-only discovery contract. It was written as a
foundation; the Windows host is now wired into enrollment, the relay and an
unsigned NSIS installer on PR #75. Current status and native Windows evidence:
[WINDOWS-RAW-TRANSPORT.md](WINDOWS-RAW-TRANSPORT.md).

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

## Real ZD421 observations (Windows 11, ZDesigner driver, 2026-11-20)

| Field | Zebra queue | Other local queues (OneNote, Print to PDF) |
| --- | --- | --- |
| Name / DriverName | `ZDesigner ZD421-203dpi ZPL` | — |
| PortName | `USB001` ("Virtual printer port for USB") | `nul:`, `PORTPROMPT:` |
| PNPDeviceID | empty | empty |
| PrinterStatus / DetectedErrorState | 3 (Idle) / 0 (Unknown) | 3 / 0 |
| PrinterState (PRINTER_STATUS_* bits) | 0 | — |
| ExtendedPrinterStatus / ExtendedDetectedErrorState | 2 / 0 | — |
| Status | `Unknown` | — |
| WorkOffline / Local / Network | False / True / False | — |

PnP had exactly one present USBPRINT device,
`USBPRINT\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\6&…&0&USB001` (its instance ID
ends in `&` plus the queue's port). Its `DEVPKEY_Device_Parent` is
`USB\VID_0A5F&PID_0185\<serial>` with `DEVPKEY_Device_Capabilities` 148
(bit 16, CM_DEVCAP_UNIQUEID, set).

### How the probe ties a queue to its serial

Only local, non-network queues on a `USB<nnn>` port are looked up:

- **PNPDeviceID empty** (the ZDesigner case): take the present (Status OK)
  PnP devices whose instance ID starts with `USBPRINT\` and ends with `&` +
  PortName, case-insensitively. Exactly one is required; zero or two gives no
  serial. The probe reports it as `usbPrintInstanceId` and the serial with
  `serialEvidence: "usbprint-port"`.
- **PNPDeviceID present**: it must itself be a USBPRINT device ending in `&` +
  PortName (review F1). A PNPDeviceID on another port gives no serial. Evidence is
  `"unique-usb-parent"`.
- Both paths then walk the parent chain to a present `USB\VID_0A5F` device with
  CM_DEVCAP_UNIQUEID. Without that, there is no serial.

The `&` delimiter keeps a queue on `USB002` from matching `…&USB001`.
Windows can give a port name to a different printer after a replug: the suffix
then finds whichever device holds the port now, and the unique serial plus the
app's paired-serial check stop a print to the wrong Zebra. `windowsDiscovery.ts`
re-checks the port suffix and the evidence/PNPDeviceID pairing before it accepts
a serial, and uses `usbPrintInstanceId` as the selection key only when
PNPDeviceID is empty.

That USBPRINT instance ID ends in the port, so when PNPDeviceID is empty the
selection key includes the port. If Windows gives the same printer a different
`USB<nnn>` port after a replug, the saved selection no longer matches and
printing stays off until someone picks the printer again. This fails closed: it
never prints to a different printer.

The port-binding logic in `probe-printers.ps1` is checked only by text
assertions in `windowsDiscovery.test.ts`. PowerShell does not run in the test
suite, so a logic error those assertions do not spell out would only show on a
Windows PC.

### Queue status

With the ZDesigner driver, DetectedErrorState 0 and ExtendedPrinterStatus 2 mean
the driver reports no status. On their own they would keep a queue `available`
whenever the printer is attached, even with paper out, the head open or the queue
paused. So the probe also reports `printerState` (Win32_Printer.PrinterState,
the spooler's PRINTER_STATUS_* bitmask) and `extendedDetectedErrorState`. Both
are optional in schemaVersion 1: an older probe that omits them, or a null value,
keeps the rules below unchanged.

Checked in this order, first match wins:

1. `offline`: WorkOffline true, PrinterStatus 7, DetectedErrorState 9, or a
   PrinterState bit OFFLINE (0x80), NOT_AVAILABLE (0x1000), SERVER_UNKNOWN
   (0x800000) or SERVER_OFFLINE (0x2000000).
2. `attention`: PrinterStatus 6, DetectedErrorState 4 (No Paper), 6 (No
   Toner), 7 (Door Open), 8 (Jammed), 10 (Service Requested) or 11 (Output Bin
   Full), or a PrinterState bit PAUSED (0x1), ERROR
   (0x2), PENDING_DELETION (0x4), PAPER_JAM (0x8), PAPER_OUT (0x10), MANUAL_FEED
   (0x20), PAPER_PROBLEM (0x40), OUTPUT_BIN_FULL (0x800), NO_TONER (0x40000),
   PAGE_PUNT (0x80000), USER_INTERVENTION (0x100000), OUT_OF_MEMORY (0x200000),
   DOOR_OPEN (0x400000) or DRIVER_UPDATE_NEEDED (0x4000000).
3. `attention`: any ExtendedDetectedErrorState other than 0 (Unknown), 2 (No
   Error), 3 (Low Paper) or 5 (Low Toner). Low paper and low toner still print.
4. `unknown`: a PrinterState bit this code does not name (0xF8000000).
5. `available`: PrinterStatus 3 (Idle), 4 (Printing) or 5 (Warmup) and
   DetectedErrorState 2 (No Error), 0 (the driver reports no status), 3 (Low
   Paper) or 5 (Low Toner). Low paper and low toner still print, as with
   ExtendedDetectedErrorState 3 and 5. PrinterState
   bits IO_ACTIVE, BUSY, PRINTING, WAITING, PROCESSING, INITIALIZING, WARMING_UP,
   TONER_LOW and POWER_SAVE do not block this.
6. Anything else, including null, is `unknown`.

None of these prove the printer is attached. The real ZD421's PrinterState and
ExtendedDetectedErrorState values for paper out, head open, a paused queue and
an unplugged printer are **not yet captured on hardware**, and neither is
PrinterState while a label is printing (expect the bitmask 0x400 PRINTING, not the
documented enumeration value 11). Microsoft documents PrinterState as an
enumeration, but the provider is reported to return the PRINTER_STATUS_* bitmask
in practice. If it returned the enumeration instead, printing (11 = 0xB) would
set PAUSED, ERROR and PAPER_JAM, so a printing ZD421 would read as `attention`.
Only the idle values
above (PrinterState 0, ExtendedDetectedErrorState 0) are real. The mapping
follows the documented PRINTER_STATUS_* bit names until those captures exist.

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
Most unit fixtures in the test file are synthetic. The "real ZD421" fixtures are
built from the 2026-11-20 capture above.

Record the Windows release, Zebra model, installed driver/version, USB connection,
and whether the process used ordinary-user permissions. Check each state:

| Case | Expected safety result |
| --- | --- |
| No configured printers | Successful JSON with `printers: []` |
| One ZD421 on USB | One USBPRINT device on the queue's port with a unique Zebra USB parent serial gets a local selection key (see above) |
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
