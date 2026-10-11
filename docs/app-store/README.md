# Favor Printer — Apple release dossier

**Status: Working drafts, NOT approved for Apple review**  
Created: 2026-10-11. Owner: Favor Church (legal entity / Apple Account Holder to verify).

This dossier prepares the store listing, user privacy review, demo instructions and release gates for a possible Mac App Store listing and/or a new native iPad app. It is NOT an App Store build, an approved legal policy, a privacy declaration, or permission to deploy or submit.

## Current architecture

The shipped Favor Printer is a macOS Electron menu-bar app that prints Zebra labels via CUPS and talks to Favor RSVP. It is deliberately unsandboxed and distributed through signed/notarized GitHub DMGs; the existing build is not proven to meet Mac App Store sandbox requirements. The iPad app is not implemented and its job remains undecided.

## Draft package

- [Store metadata](STORE-METADATA-DRAFT.md) — descriptions and fields still to confirm
- [Privacy policy](PRIVACY-POLICY-DRAFT.md) — candidate language with legal and engineering gaps
- [App privacy inventory](APP-PRIVACY-INVENTORY.md) — data flows to map into Apple's questionnaire
- [Review notes](APP-REVIEW-NOTES-DRAFT.md) — reviewer workflow and test account prerequisites
- [Release checklist](RELEASE-CHECKLIST.md) — technical, account and rollout gates
- [Support FAQ](SUPPORT-FAQ-DRAFT.md) — operations documentation
- [Screenshot shotlist](SCREENSHOT-SHOTLIST.md) — real-build captures needed

## Important blockers

1. [Decide iPad app's role](https://github.com/favorchurch/rsvp.favor.church/issues/627): iPad check-in client to Mac relay, iPad printer relay, or both.
2. [Research hardware and sandbox feasibility](https://github.com/favorchurch/rsvp.favor.church/issues/625).
3. [Choose Apple distribution](https://github.com/favorchurch/rsvp.favor.church/issues/628): public/unlisted/custom iPad and whether Mac stays direct-download.
4. Deliver [atomic cloud pairing](https://github.com/favorchurch/rsvp.favor.church/issues/623), [name editing](https://github.com/favorchurch/rsvp.favor.church/issues/629), and [Mac app-guided setup](https://github.com/favorchurch/favor-printer/issues/16).

## Controls

Keep Mac stable while researching MAS. Do not commit credentials, real attendee names, enrollment codes, or keys. Validate every privacy statement against actual production data handling. App Store upload, submission and release require the release owner's explicit authorization. No source changes or publishing are authorized by these drafts.

Apple sources: https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app ; https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy ; https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications .

Tracking: [Favor Printer release readiness](https://github.com/favorchurch/favor-printer/issues/17).