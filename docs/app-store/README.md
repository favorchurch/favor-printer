# Favor Printer: Apple release dossier

**Status: Working drafts, NOT approved for Apple review**  
Created: 2026-10-11. Owner: Favor Church (legal entity / Apple Account Holder to verify).

This dossier prepares the store listing, privacy review, reviewer instructions and release gates for the unlisted iPad App Store release, and for the separate Mac App Store question. It is NOT an App Store build, an approved legal policy, a privacy declaration, or permission to deploy or submit. It supersedes the earlier draft dossier in [PR #18](https://github.com/favorchurch/favor-printer/pull/18).

## Locked decisions every file in this folder reflects

- **Name:** **Favor Printer** on Mac and iPad. Earlier working titles are retired and must not appear in any field or document.
- **iPad v1:** native Rock event and Kids **check-in only**, and **online-only** (no offline check-in mutations or queue).
- **Printer Host:** a **later update** of the same iPad app, after hardware proof. v1 does not claim it, list it, or screenshot it.
- **Distribution:** **unlisted** App Store release shared by **direct link** only, never a searchable listing.
- **Pilots:** one concurrent controlled pilot wave at **MNL, BNE and SEL**, with per-campus go/no-go and rollback.
- **Devices:** every personally owned iPad needs an **approved check-in device grant**; the download link and a staff login are not device authorization.

## Current architecture

The shipped Favor Printer is a macOS Electron menu-bar app that prints Zebra labels via CUPS and talks to Favor RSVP. It is deliberately unsandboxed and distributed through signed/notarized GitHub DMGs; the existing build is not proven to meet Mac App Store sandbox requirements.

The native iPad app is not implemented in this repository. Its locked first-release scope is Favor Printer check-in for Rock event and Kids check-in, online only, printing through the existing cloud to Mac relay. iPad printer hosting is a committed later update of that same app, gated on hardware and iPadOS lifecycle proof.

## Draft package

- [Store metadata](STORE-METADATA-DRAFT.md): descriptions and fields still to confirm
- [Privacy policy](PRIVACY-POLICY-DRAFT.md): candidate language with legal and engineering gaps
- [App privacy inventory](APP-PRIVACY-INVENTORY.md): data flows to map into Apple's questionnaire
- [Review notes](APP-REVIEW-NOTES-DRAFT.md): reviewer workflow and test account prerequisites
- [Release checklist](RELEASE-CHECKLIST.md): technical, account and rollout gates
- [Support FAQ](SUPPORT-FAQ-DRAFT.md): operations documentation
- [Screenshot shotlist](SCREENSHOT-SHOTLIST.md): real-build captures needed

## Open gates

1. [Hardware, iPadOS lifecycle and Mac sandbox feasibility](https://github.com/favorchurch/rsvp.favor.church/issues/625) results are not recorded yet.
2. Apple developer organization account, legal seller name and release approval are unverified.
3. The privacy inventory cannot be finalized until the native API reference exists: [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/main/docs/native-api/v1.md).
4. [RSVP native iPad device grants, approved BYOD and revocation](https://github.com/favorchurch/rsvp.favor.church/issues/648) is the hard gate for personally owned iPads.
5. Deliver [atomic cloud pairing](https://github.com/favorchurch/rsvp.favor.church/issues/623), [name editing](https://github.com/favorchurch/rsvp.favor.church/issues/629), and [Mac app-guided setup](https://github.com/favorchurch/favor-printer/issues/16).

## Controls

Keep Mac stable while researching MAS. Do not commit credentials, real attendee names, enrollment codes, or keys. Validate every privacy statement against actual production data handling. App Store upload, submission and release require the release owner's explicit authorization. No source changes or publishing are authorized by these drafts.

Apple sources: https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app ; https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy ; https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications .

Tracking: [Favor Printer release readiness](https://github.com/favorchurch/favor-printer/issues/17).
