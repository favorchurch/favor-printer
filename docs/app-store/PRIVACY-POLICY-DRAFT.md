# Favor Printer privacy policy: DRAFT FOR LEGAL REVIEW

**DO NOT PUBLISH AS FINAL OR SUBMIT UNTIL APPROVED.** This template needs a verified data flow and legal review. It does not claim compliance or guarantee unverified retention periods.

**Effective date:** [INSERT DATE]  
**Legal operator / data controller:** [INSERT EXACT FAVOR CHURCH LEGAL ENTITY, COUNTRY AND ADDRESS]  
**Privacy contact:** [INSERT MONITORED EMAIL]  
**Approved public policy URL:** [INSERT HTTPS URL]

## Locked decisions this draft reflects

- **Name:** **Favor Printer** on Mac and iPad, with no retired working titles anywhere in this policy.
- **iPad v1:** native Rock event and Kids **check-in only**, **online-only**; no offline check-in data is stored for later sync.
- **Printer Host:** a **later update** of the same iPad app, not part of this release; re-audit before it ships.
- **Distribution:** **unlisted** App Store release shared by **direct link** only.
- **Pilots:** controlled pilots run concurrently at **MNL, BNE and SEL**.
- **Devices:** personally owned iPads need an **approved check-in device grant**, revocable by administrators.

## 1. Scope

This policy describes how [LEGAL ENTITY] processes personal information in Favor Printer and its connected Favor RSVP printing service for authorized Favor Church personnel. Printing may involve names and other content derived from check-in records, including information about children and families. The native iPad application in the first release is check-in only and online only; it processes the same check-in and label content for event and Kids check-in. Printer hosting on iPad is a later update and is not covered by this release.

The exact data fields the native iPad app receives are pending: they must be transcribed from [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/main/docs/native-api/v1.md) once that reference exists, not inferred. See [App privacy inventory](APP-PRIVACY-INVENTORY.md).

[VERIFY] Relationship to existing Favor Church / RSVP / Rock RMS privacy notices and laws covering the relevant countries and attendees.

## 2. Information involved

- **Device and connection information:** printer model and USB serial, registered printer IDs, opaque laptop relay IDs, device and printer display names, campus assignment, app/OS versions, heartbeat and connection status. On iPad, the check-in device identity and its approved device grant.
- **Enrollment and credentials:** one-time device codes, scoped relay tokens, revocation and security audit information. Sensitive codes/tokens must never be published or included in troubleshooting screenshots.
- **Printing and attendance content:** job identifiers, failures/outcomes and printable child/parent labels. Label payloads may include attendee names, potentially children's personal information. Printing authority and underlying source records are managed through Favor RSVP and connected church systems.
- **Technical operations:** server and client logs, support communications, network/service-provider information. [VERIFY actual collection, analytics and diagnostics.]

## 3. Why information is used

Information is used to authenticate authorized devices, route requested labels, display status, prevent misrouting/duplication, investigate failures, support church operations, and protect the system. [VERIFY organization-specific lawful basis, notices and restrictions.]

## 4. Where information is processed

The current Mac app communicates with Favor RSVP over HTTPS and with GitHub Releases for updates. It uses macOS CUPS and a local job spool. The native iPad app communicates with Favor RSVP over HTTPS only; because v1 is online-only, it does not queue check-in mutations while disconnected. The repository architecture says a label payload is removed from spool metadata after the claimed stage, but **the exact storage, failure paths, print-system spool, servers, backups and deletion deadlines have not been independently confirmed for this policy**.

[VERIFY] Cloud hosting, locations, providers, disclosure rules, linked Rock/Favor systems, analytics SDKs and cross-border handling.

## 5. Access, security and retention

Authorized personnel and approved systems should have access only for their roles. Device credentials should be protected and revoked on replacement. Personally owned iPads are permitted only with an approved, revocable check-in device grant; losing such a device should end its server access promptly, while local data on an unreachable device cannot be wiped instantly and must be minimized instead. Transmission and local processing protections must be verified before describing them as active controls. No system can guarantee absolute security.

**Retention schedule pending verification:**
- Label content and local CUPS spool: [VERIFY maximum retention, including error/crash paths].
- Cached guest and child data on iPad: [VERIFY encryption, purge on logout and on revocation, and offline limits].
- Cloud print jobs, diagnostics and status: [VERIFY production cleanup; a historical 90-day design target is not proof of current deletion].
- Registered devices, display names, credentials, device grants and audit logs: [VERIFY retention and offboarding].
- Backups, incident reports and support requests: [VERIFY provider-specific policies].

## 6. Children and families

Check-in labels can involve information about children and families. Treat these records as private; do not expose real check-in data in demo screenshots, public issues or app review test accounts.

[VERIFY] Parental notice/consent requirements, privacy law, retention and the distinction between adult app operators and children whose data are printed.

## 7. Requests and choices

To ask questions about applicable data rights or request correction or deletion, contact [INSERT PRIVACY CONTACT]. [VERIFY eligibility, identity-verification process, exceptions, response times and actual operational capability]. Device name changes do not necessarily alter historical attendance records.

## 8. Changes to this policy

Changes will be published at [APPROVED PUBLIC URL] with an updated effective date. [VERIFY notification requirements].

## Approval gates

- [ ] Actual app/API/Rock/CUPS data map and third-party inventory validated, including the native iPad API field list from [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/main/docs/native-api/v1.md)
- [ ] Legal identity, contact, rights process and child-data obligations approved
- [ ] Log/spool/job/database/backup retention verified
- [ ] Provider, hosting, security and international processing statements checked
- [ ] Existing church privacy policies reconciled
- [ ] Public URL live and linked within store listing/application
- [ ] Final policy and App Privacy answers signed off by responsible owners

Apple privacy policy requirements: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy
