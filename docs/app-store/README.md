# Favor Printer for iPad — Apple release dossier (working drafts)

**Status: NOT approved for submission.** This dossier describes the **printer-host-only** iPad application on `main`. Its review, privacy, legal and release gates remain open; an internal OTA IPA is not App Store/TestFlight approval.

Favor Printer is a dedicated iPad USB Zebra **print relay** for the Favor RSVP web check-in platform. RSVP web alone controls attendance, Kids, events, tickets and enqueueing labels. The iPad app enrolls a host to an existing canonical printer UUID and, while foregrounded, downloads approved jobs, sends ZPL over DriverKit and reports outcomes. There are **no native attendee check-in screens**.

## Supported operating mode

- Keep the iPad unlocked, in the foreground, attached to a compatible USB Zebra; use Guided Access and Auto-Lock Never. Backgrounding, locking, switching apps and interruptions **pause claiming**; queue remains in the cloud. Mac relay is the fallback.
- Debug/Internal audio/background experiments are **not an approved App Store capability**. The public Release build does not claim continuous background printing.
- Default intended distribution: **unlisted iPad App Store app via direct link**, **only after Apple entitlement approval, TestFlight device/hardware verification, legal signoff and explicit release authorization**.
- The currently supported Mac channel is the notarized GitHub DMG, not an assumed Mac App Store build.

## Working drafts

| Document | Purpose |
| --- | --- |
| [STORE-METADATA-DRAFT.md](STORE-METADATA-DRAFT.md) | Accurate host-only marketing copy, feature limits and unlisted positioning |
| [APP-REVIEW-NOTES-DRAFT.md](APP-REVIEW-NOTES-DRAFT.md) | Reviewer demo prerequisites; no invented working no-hardware mode |
| [APP-PRIVACY-INVENTORY.md](APP-PRIVACY-INVENTORY.md) | Source-backed data flow, storage and unanswered retention questions |
| [PRIVACY-POLICY-DRAFT.md](PRIVACY-POLICY-DRAFT.md) | Legal-review template, not a public policy |
| [SCREENSHOT-SHOTLIST.md](SCREENSHOT-SHOTLIST.md) | Real capture plan, only synthetic labels |
| [SUPPORT-FAQ-DRAFT.md](SUPPORT-FAQ-DRAFT.md) | Support text for foreground hosting |
| [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) | Apple, cloud, campus and explicit authorization gates |

## Evidence and non-evidence

- iPad USBDriverKit relay implementation: [Printer PR #43](https://github.com/favorchurch/favor-printer/pull/43).
- M2 iPad + USB-only Zebra ZD421 synthetic/development-signed proof: [Printer #23](https://github.com/favorchurch/favor-printer/issues/23); **not** cloud-routed parent/child acceptance.
- Apple DriverKit distribution entitlement **requested, not approved**: [Printer #49](https://github.com/favorchurch/favor-printer/issues/49).
- Canonical cloud and rollout scope: [RSVP #624](https://github.com/favorchurch/rsvp.favor.church/issues/624).
- Current code: `ios/FavorPrinter/Host/{HostLoop,HostSpool,HostController}.swift`, `ios/FavorPrinter/Relay/RelayAPIClient.swift`, `ios/FavorPrinter/PrivacyInfo.xcprivacy`, `ios/project.yml`.

The wording here is a proposed *truthful dossier*, not a claim that Apple, legal, privacy, campus leads or the user approved it.
