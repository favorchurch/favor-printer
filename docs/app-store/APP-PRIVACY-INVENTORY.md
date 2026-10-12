# App Privacy questionnaire — working data inventory

**DO NOT use as final answers without an audit.** Apple's questionnaire covers transmitted/collected data, purposes, whether linked to identity or used for tracking, and third-party partners. If using one app record across multiple platforms, disclosures must reflect data practices across the platforms.

| Data | Starting evidence | Unresolved evidence before answering Apple |
| --- | --- | --- |
| Printer model / USB serial | Enrollment and cloud printer matching | Storage, identifying/linking, retention, backups, processors |
| Laptop relay ID / device label | Supabase relay registry | Relationship to operators, logs, renames, deletion |
| Printer display name / campus / printer UUID | Cloud printer record | Who can edit/read; link to real person or account |
| App/OS version, heartbeat and printer-attached status | Mac relay health | Payload exact fields, retention, diagnostic storage |
| OTP and relay credentials | Enrollment; stored Mac secrets, hash-based server checks | Lifecycle, secure storage, logging, revoked records |
| Print job ID, outcomes and diagnostic errors | Cloud print queue + local spool | Retention, shared operators, third-party logs |
| Child/parent label payload | RSVP/Rock and CUPS during printing | Names/identifiers, failure-state retention, backups, screenshot leaks |
| Operator authorization / check-in device identity | RSVP permissions and device pairing | Whether app collects identifiers linked to a church account |
| Update downloads | GitHub Releases and electron-updater | Provider IP/logs, disclosure, separate data collection |
| Crash reporting / metrics / SDKs | No proof of complete inventory yet | Trace every dependency and network request |
| Native iPad RSVP check-in + printer hosting | **Both capabilities now in committed product scope**, but native app not implemented | Re-audit identity, children's check-in content, native host printer serial/network identifiers, permissions, location/network access, status, SDKs, crash logs and host data retention after implementation |

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

- [ ] Trace every outbound Mac main, renderer, relay, updater and native iPad request.
- [ ] Trace RSVP API and Supabase print/relay tables, RPCs and scheduled cleanup.
- [ ] Inspect local CUPS spool, log sanitization, errors and crash snapshots for child data.
- [ ] Review third-party SDK, OS and infrastructure data handling.
- [ ] Verify production RBAC, campus scoping and revocation.
- [ ] Compare Apple questionnaire with approved final privacy policy and shipping binary.

Primary sources: [Mac architecture](../ARCHITECTURE.md), [RSVP atomic enrollment requirements](https://github.com/favorchurch/rsvp.favor.church/issues/623), [Apple Privacy help](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy).