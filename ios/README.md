# Favor Printer for iPad

iPad-only SwiftUI app (display name "Favor Printer", scheme `FavorPrinter`, Swift 6 strict concurrency,
iPadOS 17+). It has the device grant flow (register, pending, approved, revoked), a hand-written client for
the device and check-in endpoints, and the volunteer screens: pick a check-in and a service for the
device's campus, search for a person, check in (event or Kids family), print labels and watch print status.
Check-in is online-only: with no network every check-in action is blocked with a message and nothing is
queued or replayed later.

## API contract

Implemented against `docs/native-api/v1.md` from favorchurch/rsvp.favor.church PR #655
(`office/ca02e6f1/T2`), commit `8a560ce305ce25252e28ce92886ecb3b9fd995bc`.

Check-in endpoints are implemented against `docs/native-api/v1.md` from favorchurch/rsvp.favor.church PR #656
(`office/ca02e6f1/T3`), rsvp commit `6462986a1d7272ffc50732222982ed0f7638c3b9`. That is the head of PR #656 when
this slice was written; the orchestrator holds the gate that T3 is accepted before T5 merges, so re-check this SHA
against the accepted T3 revision and update it with the types if it moved.

Covered: device register and status, `GET definitions, occurrences, contacts, family, printers, print/status` and
`POST check-in, family/check-in, print/enqueue` under `/api/native/v1/checkin/`, every error code in the
contract table, and the state rules below. If the contract changes, update the types in `FavorPrinter/API/` and
these SHAs together.

## Behavior

- Registration returns the bearer secret once. It goes straight into the Keychain
  (`KeychainSecretStore`, this-device-only, no iCloud sync) and is never stored anywhere else or logged.
- Non-secret state (grant id, campus, label, status, a `revoked` flag) lives in `UserDefaults`.
- Any 401, a 403 `device_revoked`, or a 200 status of `revoked` wipes the secret and shows the revoked
  screen. The revoked flag is persisted, so a failed wipe is retried on the next launch and no network
  call is made with a revoked credential. "Register again" creates a new pending grant.
- 400, 429, 503 and transport failures keep the credential and state and show a message.
- Redirects are never followed, so the bearer header cannot be forwarded.
- Every check-in call goes through `CheckinService` -> `DeviceSession.withCredential`, which only runs for an
  approved grant, reads the secret from the Keychain, drops an answer that arrives after the credential was wiped,
  and routes failures through `DeviceSession.report(_:)` so the same rules apply.
- Contract errors have their own messages: `wrong_campus` (own campus only), `definition_forbidden` (turned off or
  another campus), `occurrence_forbidden`, `printer_forbidden`; `device_revoked` and 401s wipe the secret.
- Online-only: `NetworkMonitor` (NWPathMonitor) feeds `CheckinService`. Offline, nothing is sent, the screens show
  an offline banner, and there is no queue or replay. A transport failure on a check-in write says the check-in may
  have been recorded, so the volunteer confirms before retrying. Print enqueue reuses one stable `actionId` per
  screen, so a retry queues once.
- The campus sent on every request is the approved grant's campus. The server decides what it may touch.
- HTTP 200 does not mean success: check-in, family and print results are inspected per child and per label.

## RSVP base URL

Set per build configuration in `Config/*.xcconfig` and exposed as `RSVPBaseURL` in Info.plist.
The app refuses to start unless it is HTTPS. No secrets live in config.

| Configuration | URL |
| --- | --- |
| Debug (default for simulator runs and tests) | `https://rsvp-preview.favor.church` (confirm the preview host before first device install) |
| Release | `https://rsvp.favor.church` |

Override locally with an untracked `Config/Local.xcconfig`, for example
`RSVP_BASE_URL = https:/$()/my-branch.vercel.app` (`$()` is needed because `//` starts an xcconfig comment).

## Build and test

Xcode is not the active developer directory on this machine, so set `DEVELOPER_DIR`:

```sh
cd ios
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer

# unit tests and the XCUITest on the simulator
xcodebuild test -scheme FavorPrinter -destination 'platform=iOS Simulator,name=iPad Air 13-inch (M4)' -quiet

# production-configured build
xcodebuild build -scheme FavorPrinter -configuration Release -destination 'generic/platform=iOS Simulator' -quiet
```

`-quiet` prints nothing on success; drop it to see the Swift Testing summary. The XCUITest
(`FavorPrinterUITests`) launches the Debug app with `-FavorUITestMock`, which swaps in an in-process backend
(`UITestBackend.swift`, `#if DEBUG` only): register, mocked admin approval, search, check in, print and print
status, a Kids family check-in, and the offline block (`-FavorUITestOffline`, `-FavorUITestApproved` skip
registration). It also checks every control on each screen has a VoiceOver label. Unit tests use a `URLProtocol`
mock (`FavorPrinterTests/TestSupport.swift`) and need no network. Keychain tests use a unique service
name per test and delete it afterwards.

## Layout

- `FavorPrinter/API/` Codable wire types, error codes, `DeviceAPIClient` and the check-in client (`CheckinAPIClient`).
- `FavorPrinter/Device/` `SecretStore` (Keychain), `DeviceRecordStore`, the `DeviceSession` state machine and `CheckinService`.
- `FavorPrinter/Checkin/` view models for search, check-in, family check-in and print status.
- `FavorPrinter/Views/` SwiftUI screens for each state and for the check-in flow.
- `FavorPrinterUITests/` the XCUITest.

The rsvp `docs/prototypes/printer-2` screens are not present in the T3 revision above, so the layouts follow the
flow in the contract (definition, service, search, check-in, print, status). Compare them with the prototypes
when those land.
- `Config/` xcconfig files and the Info.plist fragment holding `RSVPBaseURL`.

Physical iPad, Keychain behavior on device and offline verification remain manual checks.
