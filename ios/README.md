# Favor Printer for iPad

iPad-only SwiftUI app (display name "Favor Printer", scheme `FavorPrinter`, Swift 6 strict concurrency,
iPadOS 17+). This slice is the app shell, the device grant flow (register, pending, approved, revoked)
and a hand-written client for the device endpoints. Check-in, printing and offline queue endpoints
(T3) are not wired yet.

## API contract

Implemented against `docs/native-api/v1.md` from favorchurch/rsvp.favor.church PR #655
(`office/ca02e6f1/T2`), commit `8a560ce305ce25252e28ce92886ecb3b9fd995bc`.

Covered: `POST /api/native/v1/device/register` and `GET /api/native/v1/device/status`, every error code
in the contract table, and the state rules below. If the contract changes, update the types in
`FavorPrinter/API/` and this SHA together.

## Behavior

- Registration returns the bearer secret once. It goes straight into the Keychain
  (`KeychainSecretStore`, this-device-only, no iCloud sync) and is never stored anywhere else or logged.
- Non-secret state (grant id, campus, label, status, a `revoked` flag) lives in `UserDefaults`.
- Any 401, a 403 `device_revoked`, or a 200 status of `revoked` wipes the secret and shows the revoked
  screen. The revoked flag is persisted, so a failed wipe is retried on the next launch and no network
  call is made with a revoked credential. "Register again" creates a new pending grant.
- 400, 429, 503 and transport failures keep the credential and state and show a message.
- Redirects are never followed, so the bearer header cannot be forwarded.
- Other API calls should route failures through `DeviceSession.report(_:)` so the same rules apply.

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

# unit tests on the simulator
xcodebuild test -scheme FavorPrinter -destination 'platform=iOS Simulator,name=iPad Air 13-inch (M4)' -quiet

# production-configured build
xcodebuild build -scheme FavorPrinter -configuration Release -destination 'generic/platform=iOS Simulator' -quiet
```

`-quiet` prints nothing on success; drop it to see the Swift Testing summary. Tests use a `URLProtocol`
mock (`FavorPrinterTests/TestSupport.swift`) and need no network. Keychain tests use a unique service
name per test and delete it afterwards.

## Layout

- `FavorPrinter/API/` Codable wire types, error codes and `DeviceAPIClient`.
- `FavorPrinter/Device/` `SecretStore` (Keychain), `DeviceRecordStore`, and the `DeviceSession` state machine.
- `FavorPrinter/Views/` SwiftUI screens for each state.
- `Config/` xcconfig files and the Info.plist fragment holding `RSVPBaseURL`.

Physical iPad, Keychain behavior on device and offline verification remain manual checks.
