# Favor Printer iPad — privacy / data flow inventory (verification draft)

**Needs privacy counsel and backend retention confirmation.** Source paths below describe code in the 2026-10-19 repo, not a completed Apple App Privacy questionnaire. Favor Printer is a **relay only**; it does not search or check in attendees.

| Data | Source → iPad usage | Storage / protection | Review action |
| --- | --- | --- | --- |
| Expiring one-time enrollment code | RSVP admin → iPad enrollment request over HTTPS | Entered temporarily in form; confirm UI/diagnostic retention | Confirm no analytics/log echo and expiration policy |
| Relay ID, scoped bearer token | RSVP response → subsequent authorized cloud requests | Host credential stored in iOS Keychain; description and mirror redact token (`HostCredential.swift`, `RelayAPIClient.swift`) | Confirm Keychain access class, deletion/revocation and backup policy |
| Canonical printer UUID, campus, names, host kind | RSVP registry → app config/status, enrollment and claims | Visible non-secret metadata; never identity derived from display name | Confirm registry audit/retention and campus access |
| Printer hardware USB identifiers and device status | DriverKit USB → host diagnostics and heartbeat | Device hardware fingerprint may be sensitive; logs/status must not reveal full identifiers | Confirm serial visibility, telemetry, retention |
| Cloud print job ID, claim token, attempt, lease, outcome | RSVP queue → relay send/report | Durable app-container spool to survive crash; job ID and claim token retained until acknowledged | Confirm deletion timing, error/backup retention |
| ZPL and optional printable label text | RSVP queue → USB Zebra; **can contain child's and parent's names/label information** | `HostSpool.swift`: stored only in `claimed` stage; removed on `sending` and `report` writes, excludes directory from backups, file protection `completeUntilFirstUserAuthentication` | Confirm OS copies, crash dumps, no print payload in logs, privacy classification |
| Health metrics and last result | Host loop → RSVP heartbeat/admin | Count/state/diagnostic fields, fixed error strings, not raw ZPL | Verify server retention, exports and staff access |
| Foreground experiment preference | UserDefaults for internal builds; release policy foreground only | `PrivacyInfo.xcprivacy` declares UserDefaults accessed API reason `CA92.1` | Confirm intended Release build excludes unsupported audio mode |
| Legacy device check-in grant | Earlier iPad builds only | `StaleDeviceBearer.deleteOnce` removes old Keychain grant on launch | Verify removal on upgraded devices; no native check-in remains |

## Network and third-party review

The iPad contacts the configured HTTPS RSVP relay API (`/api/printing/relay/*`); production Release configuration restricts to `https://rsvp.favor.church` (`AppConfig.swift`). `RelayAPIClient.swift` uses ephemeral URL sessions and a redirect-refusing delegate. The native app uses Apple's first-party frameworks (SwiftUI, Keychain, DriverKit, URLSession and related system libraries). **Verify** the entire dependency/binary/SBOM and any crash-reporting, analytics, support and external tools before saying no other recipients exist.

`ios/FavorPrinter/PrivacyInfo.xcprivacy` currently declares tracking false and an empty collected-data array. That is a **manifest statement, not proof** of Apple's data collection categorization. Whether print label transit, cloud-hosted registries and server logs constitute linked collected data under Apple's questionnaire requires legal/privacy review.

## Unresolved decisions — stop release until answered

- Controller and processor/legal entity, privacy contact and approved public policy URL
- Which App Privacy data categories apply to transient child/family label content and hardware identifiers, linked-to-user classification, purposes, tracking/analytics declaration
- Actual spool, server queue, audit, security-log and backup retention periods; deletion and access-request workflow
- Dext entitlement approval; analytics SDK/crash dump/privacy manifest audit of **signed binary**
- Encryption in transit and at rest evidence, cross-border processors, campus authorization and screenshot redaction
- Legal approval of accurate representations and real public support channel

**Never paste live OTPs, bearer credentials, USB serials in full, attendee names or real print payloads into GitHub or Apple screenshots.**
