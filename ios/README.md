# Favor Printer for iPad

iPad-only SwiftUI app (display name "Favor Printer", scheme `FavorPrinter`, Swift 6 strict concurrency,
iPadOS 17+). It is a print relay for the iPad's USB printer: it launches straight into the Printer Host screen,
enrolls with a one-time code, claims print jobs from the cloud relay and writes them to the printer through a
DriverKit extension. There is no check-in, device registration or navigation: earlier builds had a check-in app and
a device grant flow, and both are gone.

On launch the app deletes, once, the check-in bearer an older build may have left in the Keychain (service
`church.favor.printer.device`) and the old grant record in `UserDefaults`. Nothing reads either
(`StaleDeviceBearer` in `FavorPrinter/Device/SecretStore.swift`). A Keychain that will not delete is retried on the
next launch.

## RSVP base URL

Set per build configuration in `Config/*.xcconfig` and exposed as `RSVPBaseURL` in Info.plist. It is the
host of the relay API (`/api/printing/relay/*`). The app refuses to start unless it is HTTPS. No secrets live in config.

| Configuration | URL |
| --- | --- |
| Debug (default for simulator runs and tests) | `https://rsvp-preview.favor.church` (confirm the preview host before first device install) |
| Release | `https://rsvp.favor.church` |

Override locally with an untracked `Config/Local.xcconfig`, for example
`RSVP_BASE_URL = https:/$()/my-branch.vercel.app` (`$()` is needed because `//` starts an xcconfig comment).

## Build and test

The Xcode project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`) and is not committed. Run `xcodegen generate` first and again after adding, removing
or renaming files or changing build settings. Edit `project.yml`, never the generated project.

Xcode is not the active developer directory on this machine, so set `DEVELOPER_DIR`:

```sh
cd ios
xcodegen generate
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

# unit tests and the XCUITest on the simulator
xcodebuild test -scheme FavorPrinter -destination 'platform=iOS Simulator,name=iPad Air 13-inch (M4)' -quiet

# production-configured build
xcodebuild build -scheme FavorPrinter -configuration Release -destination 'generic/platform=iOS Simulator' -quiet
```

`-quiet` prints nothing on success; drop it to see the Swift Testing summary. The XCUITest
(`FavorPrinterUITests`) launches the Debug app with `-FavorUITestMock`, which swaps in an in-process relay and
Keychain (`UITestBackend.swift`, `#if DEBUG` only) and checks every control on the host screen has a VoiceOver label.
Unit tests use a `URLProtocol` mock (`FavorPrinterTests/TestSupport.swift`) and need no network. Keychain tests use a
unique service name per test and delete it afterwards.

## Layout

- `FavorPrinter/Device/` `SecretStore` (the Keychain item holding the relay credential) and the stale-bearer cleanup.
- `FavorPrinter/Relay/` `RelayAPIClient`, the relay HTTP client.
- `FavorPrinter/Views/` the Printer Host screen and its root.
- `FavorPrinter/Printing/Transport/` `UsbPrinterTransport` (raw ZPL in, bytes written or a typed `UsbTransportError` out),
  `DriverKitUsbTransport` (IOKit user client to the dext), `FakeUsbTransport` and the IOReturn mapping.
- `FavorPrinter/Host/` the host side: `HostController` (enrollment, credential, scene phase), `HostLoop` (claim, send,
  report), `HostSpool` (the on-disk job spool), `HostCredentialStore` and the DEBUG-only `FakeRelay`.
- `FavorPrinterDriver/` the DriverKit extension (`FavorPrinterUsbDriver`, `FavorPrinterUsbUserClient`), `FavorZplUserClientABI.h` (selector and scalar layout shared with Swift) and
  `FavorZplTransferGate.h` (one-transfer-at-a-time gate and the Stop ordering, plain C so Swift tests can run it).
- `FavorPrinterUITests/` the XCUITest.
- `Config/` xcconfig files and the Info.plist fragment holding `RSVPBaseURL`.

Physical iPad and Keychain behavior on device remain manual checks.

## USB printing: driver extension

An iPad cannot print to the USB-only Zebra ZD421 without a USBDriverKit extension. `FavorPrinterDriver` (bundle id
`church.favor.printer.ios.driver`, SDKROOT `driverkit`) claims the printer's `IOUSBHostInterface` and exposes an IOKit user
client with three selectors: send raw bytes (at most 256 KiB per call, the Swift side splits larger payloads), driver status
(start-up stage, error, bulk OUT and bulk IN endpoint addresses, device serial string) and a bulk IN status read with a
timeout (for example after sending `~HS`). Selector numbers and scalar layouts are defined once in
`FavorPrinterDriver/FavorZplUserClientABI.h` and imported into Swift through `FavorPrinter/Bridging-Header.h`.

The dext registers its service first and never fails after that, so the app can always read the stage it reached
(8 is ready). A printer with no bulk IN endpoint still prints; reading status then fails with a typed
`readFailed`, not a crash. `status()` reports `DriverAvailability`: `.running` (service matched and its user client opens),
`.printerPresentDriverNotRunning` (the IORegistry shows VID 0x0A5F PID 389 but there is no working dext service) or
`.unknown` (neither; whether the driver is enabled cannot be inferred).
The app enumerates `IOUserService` entries and, as a fallback, their children under the matching USB interface; it
does not require registry identity properties to be present. It opens each candidate and asks the status selector
for the fixed `FVPR` magic and ABI version. Only a matching magic and `kFavorZplABIVersion` identify this dext.
Registry identity properties are retained as diagnostic hints only. A candidate with a different answer is closed
and reported as a foreign driver; every rejected connection is closed. A matching magic with a different ABI keeps
the typed `UsbTransportError.abiMismatch`, and sends or reads nothing. Bump the ABI version when a selector, scalar
layout or limit changes. DEBUG builds expose each candidate's class, open result, magic, ABI and stage in the host
screen's Printer diagnostics section. The IORegistry lookup is best effort, so
`printerAttached` is `true` or `nil`, never `false`. Its result on a real iPad is recorded at the hardware gate.

`DriverKitUsbTransport` opens a fresh user client for every call, so a replug or a driver reload needs no reconnect logic.
It maps every IOKit failure to a `UsbTransportError`, keeps the byte count of a partial write and never logs ZPL.
A payload over 256 KiB goes out as several send calls. The dext's transfer gate keeps one transfer at a time but is
released between chunks, so use a single `DriverKitUsbTransport` per app. The dext does not authenticate its callers:
any app holding `communicates-with-drivers` can open it (`allow-third-party-userclients` is required for the app to
reach it at all), so treat the printer as shared with other entitled apps on the device. On `Stop` the dext closes the
gate, aborts in-flight transfers and waits (at most 6 s). It frees the pipes only if the transfer left in time
(`FavorZplGateCanFreePipes`), otherwise it leaks them.
Tests run it against a scripted backend (`UsbTransportTests.swift`); none touches IOKit or a printer.

### Gotchas (each one failed silently in the spike, issue #23)

- Embed the dext at `<App>.app/SystemExtensions/` (`$(SYSTEM_EXTENSIONS_FOLDER_PATH)` on iOS). `DriverExtensions/` installs
  but is ignored. `project.yml` does this with a copy destination on the dext dependency.
- The signed `idVendor` in the dext's `com.apple.developer.driverkit.transport.usb` entitlement must be the string `"*"`
  to match the development profile. The integer 2655 makes installd reject the app (`0xe8008015`).
- Distribution (TestFlight, App Store) needs Apple to approve Zebra's vendor ID 0x0A5F for team 3JJ4492TV8 in place of
  `"*"`. That request has not been made, so only development-signed device builds work today.
- The app needs `com.apple.developer.driverkit.communicates-with-drivers` (`FavorPrinter.entitlements`) and the dext
  needs `com.apple.developer.driverkit` and `allow-third-party-userclients`.
- Remove every other dext that matches VID 0x0A5F PID 389 (e.g. the spike app) before testing. Its toggle being off did not
  stop it matching on iPadOS 18.6.2. The spike's dext (`church.favor.printer.spike.driver`) once held the printer while the
  app opened its user client by class name, showed "Driver: Running" and failed every send with `kIOReturnNotReady`.
  The production dext classes are named `FavorPrinterUsbDriver` / `FavorPrinterUsbUserClient`, and the app matches on bundle id.
- Turn the driver on in Settings > Favor Printer > Drivers (iPadOS 18), then unplug and replug the printer. The dext is
  matched when the USB interface appears, so enabling it with the printer already attached does nothing until a replug.
- The Info.plist has exactly one personality, keyed `idVendor` + `idProduct` + `bConfigurationValue` + `bInterfaceNumber`.
  `idVendor` + `bInterfaceClass` never matched.
- DriverKit needs an M-series iPad and a DriverKit development provisioning profile. The simulator cannot load a dext, so
  a simulator destination builds the dext unsigned (`CODE_SIGNING_ALLOWED` is keyed on `TARGET_DEVICE_PLATFORM_NAME` in
  `project.yml`) and the simulator unit tests still run. Check the device build with
  `xcodebuild build -scheme FavorPrinter -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO`.

## Host mode: print jobs from the cloud relay

The iPad can act as the venue relay for its USB printer: it claims print jobs from the cloud relay API
(`/api/printing/relay/*`), writes each one to the printer through the dext and reports the outcome. The host code is
in `FavorPrinter/Host/`. It is foreground-only (see below), so it is for an iPad that stays open on the app.

### Semantics

- **Enrollment.** `HostController.enroll(code:)` redeems a one-time code at the configured RSVPBaseURL together with the
  attached printer's USB serial. It needs the dext running and a serial, otherwise it fails with `printerNotReady`
  before any request. The returned relay id and token are saved as one Keychain item (`HostCredentialStore`, service
  `church.favor.printer.relay`) and never logged. Then `config()` is fetched.
  A 409 `printer_conflict` surfaces its reason; any failed enroll stores nothing and leaves an earlier credential alone.
  `unenroll()` stops the loop and deletes only the host item, not the spool. A job left
  in the spool keeps its label text on disk until the next enrollment, where the cloud refuses it as stale and it is dropped.
  Enrolling against production needs separate approval; no test does it.
- **Spool.** One JSON file per unreported job in `Application Support/FavorPrinter/HostSpool`, written to a temp file,
  synced and renamed into place, so a crash leaves the old or the new entry and never a torn one. Stages are
  `claimed`, `sending` and `report`. Only `claimed` holds the ZPL and label; later stages drop them (`SpoolEntry` cannot
  represent anything else). Spool depth is the number of files, and it is what the heartbeat reports.
- **Sending.** A claimed job is marked `sending` in the spool before the cloud is told and before any byte goes to the
  transport. If the cloud answers `sending` with an error, the job goes back to `claimed` (nothing was written). If it
  answers stale (given away or expired), the entry is dropped and nothing is printed.
- **Outcomes.** `sent` for a clean full write. `failed` only when the transport proves nothing was written (driver not
  found, printer not attached, user client would not open). A partial write, a short write, a timeout or any other
  failure after a write began is `ambiguous`, and so is any job found in `sending` at launch: it is reported
  `ambiguous` and never sent again. The outcome is written to the spool before it is reported.
- **Reports** are retried every cycle until the cloud answers. A stale answer drops the entry. A 401 (`auth`) stops the
  loop, shows an error and keeps the credential and the spool; going to the background and back does not retry it,
  `retryAfterAuthError()` does.
- **Handover.** Enroll and every heartbeat send `hostKind: "ipad"`; heartbeats also send `lifecycle: "active"`. When the
  app goes to the background (foreground-only mode) the host sends one best-effort `lifecycle: "paused"` heartbeat under a
  short `UIApplication` background task, beside the lifecycle queue so it never delays a send or the stop; a failure is
  ignored and the next heartbeat after returning active sends `active`. A 409 `host_active` enroll conflict tells the
  volunteer to ask an RSVP admin to confirm a handover and use the new code. `handedOverFrom` from a successful enroll
  shows as "Took over from Mac '<label>'". A claim 403 `printer_handed_over`, or a 200 claim whose `handedOverPrinterIds`
  names our printer, is terminal for that printer: no more claims, sends or heartbeats, the credential is kept and the
  status shows "Printer moved to another host". Claiming resumes only after a new enrollment or an app relaunch. A
  `sending` refusal keeps the stale rule (never resend), and the `ambiguous` rule is unchanged. Unknown or absent fields
  are tolerated.
- **Heartbeat** sends `printerAttached`, `spoolDepth`, `appVersion` and `osVersion` every 15 s. The loop claims only
  when the printer is attached and the driver extension answers, only for printers the cloud lists as enabled, and
  never holds more than 20 jobs.

### Foreground only

Normally there are no background tasks, push wakeups or background modes. `HostController.scenePhaseChanged(_:)` stops
the loop on `.background` (waiting for a send already writing, never cutting it short) and starts it again on `.active`;
`.inactive` changes nothing. While the app is not in the foreground nothing is claimed or sent, jobs wait at the cloud,
and a claimed job whose lease runs out is dropped when the loop resumes. The view must call `scenePhaseChanged` for the
current phase when it appears, since the loop starts only once the app is known to be active.

DEBUG builds have an unsupported background execution experiment, enabled only with the launch argument
`-FavorHostBackgroundExperiment`. It keeps the host loop running while iOS grants one background task; when that task
expires, the loop stops after any send already in progress completes. With `-FavorHostFakeRelay`, a synthetic label is
queued every 20 seconds while backgrounded. The DEBUG-only Background experiment section records lifecycle times,
background job outcomes and heartbeat time in UserDefaults so the observations remain visible after relaunch. It stores
no labels or ZPL. The flag is ignored in Release and does not make background printing a supported operating mode.

A second DEBUG experiment, `-FavorHostKeepAliveAudio`, implies the first and also plays a looping silent buffer
(`.playback`, `.mixWithOthers`) while backgrounded, to try to keep the app running past the background task. Audio
starts on `.background`, stops on `.active` and re-activates after an interruption; these events are recorded in the
Background experiment section. The `audio` UIBackgroundModes entry exists only in the Debug Info.plist
(`Config/Info-Debug.plist`). This is unsupported: App Store review (guideline 2.5.4) rejects silent-audio keep-alive,
so it suits only internal or ad hoc distribution. The flag is ignored in Release.

### Fake relay and fake transport (DEBUG)

Two independent DEBUG-only launch arguments:

- `-FavorHostFakeRelay` runs the host against `FakeRelay`, an in-process relay with one demo label. It forces the fake
  even when a real host credential is stored, never reads that credential, builds no HTTP client (so nothing can reach
  the network) and refuses `enroll(code:)`. Its spool is a separate directory (`HostSpoolFake`), so fake jobs never mix
  with real ones. It does not change the printer: the synthetic label goes through the real `DriverKitUsbTransport`, the
  dext and the printer, which is what the hardware gate tests.
- `-FavorHostFakeTransport` swaps the printer for `FakeUsbTransport` (bytes are only recorded in memory). It exists for
  simulator UI tests, which have no dext, and is never implied by the relay argument. It combines with either relay mode.

| Arguments | Relay | Printer |
| --- | --- | --- |
| none | cloud relay if a credential is stored, else not enrolled | DriverKit |
| `-FavorHostFakeRelay` | `FakeRelay` | DriverKit |
| `-FavorHostFakeTransport` | as with none | `FakeUsbTransport` |
| both | `FakeRelay` | `FakeUsbTransport` |

Without `-FavorHostFakeRelay` a stored credential selects the real relay and none means not enrolled. `FakeRelay` and
`FakeUsbTransport` selection exist only in DEBUG; both arguments are ignored in Release.

### Printer Host screen

The app opens on this screen (`Views/HostViews.swift`). It shows the printer and driver state (`DriverAvailability`: running; printer seen but driver not running, with the
Settings > Favor Printer > Drivers hint and "replug after enabling"; unknown, "attach the printer to check"), whether
the host is running or paused, spool depth, the last job outcome with its time and the last error. `HostStatus` carries
`driver`, `lastJobOutcome`, `lastJobAt` and `lastError` for this. The last error is one of the loop's fixed phrases,
never ZPL, label text, a name or a job id. Not enrolled, it offers a one-time code field and an Enroll button
(`HostController.enroll(code:)`, with the 409 conflict reason shown); enrolled, it shows an Unenroll control that asks
first. A DEBUG build on the fake relay also shows "Print synthetic test label" and "Print large synthetic label" (an uncompressed ~200 KB `^GFA` graphic that goes out as
several send calls, for unplugging the printer mid-send). Every DEBUG build shows "Read printer status
(~HS)" under "Printer diagnostics": it pauses the loop (waiting for a send already writing), sends `~HS`, reads the
answer, shows the byte count and its printable ASCII or the typed error, and resumes the loop, so the read never shares
the wire with a job. Release builds compile neither.
`HostStatusUITests` drives the screen with `-FavorUITestMock` plus either `-FavorHostFakeRelay -FavorHostFakeTransport` (the simulator cannot load the dext, so the fake printer is needed) or the mocked enroll
call (code `CONFLICT` is refused with a conflict; `-FavorUITestDriverOff` fakes a printer without a running driver).

### Tests

`HostLoopTests.swift` has example tests for the spool, the loop, enrollment, scene phase and relay selection, all
against fakes and the `URLProtocol` mock. `HostLoopModelTests.swift` drives seeded random command sequences (enqueue
jobs, printer success, failure, partial write or timeout, relay network error, stale or auth, unplug and replug, and a
crash and restart at any call boundary) against a reference model. Each step checks: no job is sent twice, every job
that reached `sending` is reported `sent`, `failed` or `ambiguous` exactly once, unknown outcomes are `ambiguous`,
the spool holds ZPL only in `claimed` entries, and spool depth equals the jobs still owed a report. A failure prints
its seed: rerun it with `HOST_MODEL_SEED=<seed>` (on a simulator pass `TEST_RUNNER_HOST_MODEL_SEED=<seed>`), and raise
the depth with `HOST_MODEL_SEEDS` and `HOST_MODEL_STEPS`.
