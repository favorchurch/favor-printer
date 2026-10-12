# App Privacy questionnaire: working data inventory

**DO NOT use as final answers without an audit.** Apple's questionnaire covers transmitted/collected data, purposes, whether linked to identity or used for tracking, and third-party partners. If using one app record across multiple platforms, disclosures must reflect data practices across the platforms.

## Locked decisions this inventory reflects

- **Name:** **Favor Printer** on Mac and iPad, with no retired working titles anywhere in this inventory.
- **iPad v1:** native Rock event and Kids **check-in only**, **online-only**; no offline check-in queue exists to disclose.
- **Printer Host:** a **later update** of the same iPad app, not in this release; audit it before it ships.
- **Distribution:** **unlisted** App Store release shared by **direct link** only.
- **Pilots:** controlled pilots run concurrently at **MNL, BNE and SEL**.
- **Devices:** personally owned iPads need an **approved check-in device grant**, which is itself a data point to disclose.

## Native iPad API data: PENDING

The exact data the native iPad app returns must be listed field for field from the native API reference, [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/main/docs/native-api/v1.md). **That reference does not exist yet, so this section is pending and no Apple answer may be drafted from it.** When the file lands, transcribe its response fields verbatim into the table below, then map each to an Apple data type. Do not infer fields from app behavior, screenshots or older RSVP endpoints.

| Native API field (from `docs/native-api/v1.md`) | Apple data type | Purpose | Linked to identity | Retention | Recipients |
| --- | --- | --- | --- | --- | --- |
| [PENDING: copy exactly from rsvp docs/native-api/v1.md] | [MAP] | [MAP] | [CHECK] | [VERIFY] | [VERIFY] |

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
| Native iPad event and Kids check-in (v1) | **Check-in only and online only; native app not implemented** | Awaiting the field list in [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/main/docs/native-api/v1.md); then re-audit identity, children's check-in content, permissions, network access, status, SDKs, crash logs and local cache retention |
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

- [ ] Transcribe the native iPad API field list from [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/main/docs/native-api/v1.md) as soon as it exists, and complete the pending table above.
- [ ] Trace every outbound Mac main, renderer, relay, updater and native iPad request.
- [ ] Trace RSVP API and Supabase print/relay tables, RPCs and scheduled cleanup.
- [ ] Inspect local CUPS spool, log sanitization, errors and crash snapshots for child data.
- [ ] Review third-party SDK, OS and infrastructure data handling.
- [ ] Verify production RBAC, campus scoping, device grants and revocation.
- [ ] Compare Apple questionnaire with approved final privacy policy and shipping binary.

Primary sources: [Mac architecture](../ARCHITECTURE.md), [RSVP atomic enrollment requirements](https://github.com/favorchurch/rsvp.favor.church/issues/623), [Apple Privacy help](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy).
