# App Privacy questionnaire: working data inventory

**DO NOT use as final answers without an audit.** Apple's questionnaire covers transmitted/collected data, purposes, whether linked to identity or used for tracking, and third-party partners. If using one app record across multiple platforms, disclosures must reflect data practices across the platforms.

## Locked decisions this inventory reflects

- **Name:** **Favor Printer** on Mac and iPad, with no retired working titles anywhere in this inventory.
- **iPad v1:** native Rock event and Kids **check-in only**, **online-only**; no offline check-in queue exists to disclose.
- **Printer Host:** a **later update** of the same iPad app, not in this release; audit it before it ships.
- **Distribution:** **unlisted** App Store release shared by **direct link** only.
- **Pilots:** controlled pilots run concurrently at **MNL, BNE and SEL**.
- **Devices:** personally owned iPads need an **approved check-in device grant**, which is itself a data point to disclose.

## Native iPad API data (from `docs/native-api/v1.md`)

The data the native iPad app receives is transcribed field for field below from the accepted native API contract, [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/8a560ce305ce25252e28ce92886ecb3b9fd995bc/docs/native-api/v1.md) at commit `8a560ce305ce25252e28ce92886ecb3b9fd995bc` (PR #655), the revision this release's iPad client implements against. The file is not on rsvp `main` yet, so the link is pinned to that commit; the check-in endpoints at commit `6462986a1d7272ffc50732222982ed0f7638c3b9` (PR #656) carry the identical file. Only fields the API returns are listed, exactly as the contract defines them; nothing is inferred from app behavior, screenshots or older RSVP endpoints. Requests carry only the contract's input fields: campus and definition/occurrence/contact IDs, a 2-100 character search query, a 1-80 character device label, print attendance and printer IDs, and replay metadata.

| Native API field (from `docs/native-api/v1.md`) | Apple data type | Purpose | Linked to identity | Retention | Recipients |
| --- | --- | --- | --- | --- | --- |
| `apiVersion` (every success response) | None; protocol version | Not user data | No | n/a | n/a |
| `grant.id`, `grant.campusId`, `grant.label`, `grant.status`, `grant.createdAt`, `grant.approvedAt`, `grant.revokedAt` (exactly these seven; `POST /device/register` 201 and `GET /device/status` 200) | Device identifier; device label [MAP] | App functionality: device grant state | Linked to a campus and an admin-created device label | [VERIFY: RSVP grant and audit records] | [VERIFY: RSVP infrastructure] |
| `token` (`checkin_device_...`; registration response only, never again) | Security credential [CONFIRM: not an Apple category] | Authenticate the device | No; stored in the iOS Keychain and hashed server-side | [VERIFY] | [VERIFY] |
| `definitions[]`: `definitionName`, `title`, `campusId`, `source`, `sourceId` | Other user content [MAP] | App functionality: choose a check-in definition | Campus scope only; no person identity | [VERIFY] | [VERIFY] |
| `occurrences[]`: `eventId`, `definitionName`, `title`, `startDate`, `endDate` | Other user content [MAP] | App functionality: choose an event occurrence | Campus and definition scope; no person identity | [VERIFY] | [VERIFY] |
| `contacts[]`: `contactId`, `personId`, `firstName`, `lastName`, `preferredName`, `age`, `gender`, `campusIds` (the contract allows no phone, email, notes or raw Rock payload) | Name; age and gender [MAP] | App functionality: search contacts for check-in | Yes: same-campus Rock person and alias IDs | [VERIFY: RSVP/Rock retention, backups] | [VERIFY] |
| `result` at `GET /checkin/family`: `found`, `siblings`, `choices`, `selectedChoiceId`, `remember`, `remembered` (the `KidsSibling` and `PickupPhoneChoice` kiosk projections are normative for `siblings` and `choices`) | Name; pickup contact choices [MAP] | App functionality: family check-in and pickup choice | Yes: child and adult alias records | [VERIFY] | [VERIFY] |
| `result` at `POST /checkin/check-in`: `ok`, `data.outcome`, `data.attendanceId` | Other user content [MAP] | App functionality: record attendance | Yes: attendance record | [VERIFY] | [VERIFY] |
| `result` at `POST /checkin/family/check-in`: `children[].childAliasId`, `children[].status`, `children[].attendanceId`, `children[].targets[].eventId`, `children[].targets[].ok`, `children[].targets[].attendanceId`, `printAttendanceIds`, `pickup.saved`, `print.status` | Other user content [MAP] | App functionality: family attendance and print outcome | Yes: child alias and attendance records | [VERIFY] | [VERIFY] |
| `printers[]`: `id`, `name`, `laptopLabel`, `campusId`, `campusLabel`, `health` | Other user content [MAP] | App functionality: choose a printer | Device and campus labels; no person identity | [VERIFY] | [VERIFY] |
| `result` at `POST /checkin/print/enqueue`: `ok`, `created`, `jobIds`, plus partial `refused` entries | Other user content [MAP] | App functionality: enqueue labels | Yes: attendance IDs in the job | [VERIFY] | [VERIFY] |
| `result` at `GET /checkin/print/status`: `state`, `chip.tone`, `chip.text`, `printer.id`, `printer.name`, `printerName`, `jobs` | Other user content [MAP] | App functionality: show print status | Printer identity only | [VERIFY] | [VERIFY] |
| Every error response: `error` code only (no exception text, no echoed input) | None | Not user data | No | n/a | n/a |

Audit notes from the same contract: the bearer secret is returned only by registration, lives in the iOS Keychain, and never appears in status or admin responses; refusals are audited with an enumerated reason plus server-derived grant and campus IDs only.

## Current evidence table (Mac relay and RSVP paths)

| Data | Starting evidence | Unresolved evidence before answering Apple |
| --- | --- | --- |
| Printer model / USB serial | Enrollment and cloud printer matching | Storage, identifying/linking, retention, backups, processors |
| Laptop relay ID / device label | Supabase relay registry | Relationship to operators, logs, renames, deletion |
| Printer display name / campus / printer UUID | Cloud printer record | Who can edit/read; link to real person or account |
| App/OS version, heartbeat and printer-attached status | Mac relay health | Payload exact fields, retention, diagnostic storage |
| OTP and relay credentials | Enrollment; stored Mac secrets, hash-based server checks | Lifecycle, secure storage, logging, revoked records |
| Print job ID, outcomes and diagnostic errors | Cloud print queue + local spool | Retention, shared operators, third-party logs |
| Child/parent label payload | RSVP/Rock and CUPS during printing | Names/identifiers, failure-state retention, backups, screenshot leaks |
| Operator authorization / check-in device identity | RSVP permissions, device pairing, approved check-in device grant | Whether app collects identifiers linked to a church account |
| Update downloads | GitHub Releases and electron-updater | Provider IP/logs, disclosure, separate data collection |
| Crash reporting / metrics / SDKs | No proof of complete inventory yet | Trace every dependency and network request |
| Native iPad event and Kids check-in (v1) | **Check-in only and online only; native SwiftUI app in `ios/`** | Response fields transcribed above from [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/8a560ce305ce25252e28ce92886ecb3b9fd995bc/docs/native-api/v1.md); still to audit: identity linkage, children's check-in content, permissions, network access, status calls, SDKs, crash logs and local cache retention |
| iPad printer hosting | **Later update, not in this release** | Do not answer Apple for it now; audit the host printer serial/network identifiers when the update is built |

## Apple response worksheet

1. Does the app or a third party collect data? [AUDIT; do not assert 'none'.]
2. For each transmitted item, which Apple data type applies? [MAP.]
3. What is its purpose: app functionality, diagnostics, other? [DECIDE FROM EVIDENCE.]
4. Is it linked to the user's identity? [CHECK all device/person/account joins.]
5. Is it used to track across third-party apps/sites? [AUDIT SDKs and partners.]
6. Is collection required vs optional? [MAP actual user controls.]
7. Who are processors and recipients? [VERIFY actual infrastructure providers.]
8. How long is it stored including backups and crash paths? [VERIFY actual configs.]
9. How is access/correction/deletion requested? [OPERATIONS + LEGAL APPROVAL.]
10. Is the privacy policy URL approved, HTTPS and public? [TEST.]

## Technical audit checklist

- [x] Transcribed the native iPad API response fields from [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/8a560ce305ce25252e28ce92886ecb3b9fd995bc/docs/native-api/v1.md) at commit `8a560ce305ce25252e28ce92886ecb3b9fd995bc` into the table above; the Apple data-type mapping still needs the audit.
- [ ] Trace every outbound Mac main, renderer, relay, updater and native iPad request.
- [ ] Trace RSVP API and Supabase print/relay tables, RPCs and scheduled cleanup.
- [ ] Inspect local CUPS spool, log sanitization, errors and crash snapshots for child data.
- [ ] Review third-party SDK, OS and infrastructure data handling.
- [ ] Verify production RBAC, campus scoping, device grants and revocation.
- [ ] Compare Apple questionnaire with approved final privacy policy and shipping binary.

Primary sources: [Mac architecture](../ARCHITECTURE.md), [RSVP atomic enrollment requirements](https://github.com/favorchurch/rsvp.favor.church/issues/623), [Apple Privacy help](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy).
