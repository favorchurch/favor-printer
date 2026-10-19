# Favor Printer iPad — unlisted release checklist (OPEN)

**Do not merge/deploy/release/submit based on this document.** Each gate needs owner, evidence and explicit authorization. Internal OTA build, approved UX prototype and synthetic hardware print are **not** sufficient signoffs.

## Source and privacy accuracy

- [ ] App has **no native Event/Kids/team/ticket check-in**; RSVP web remains sole controller.
- [ ] iPad Release and TestFlight build is **dedicated foreground relay only**: lock/app switch/background pauses claims, no misleading silent-audio promise.
- [ ] Canonical UUID, campus and scoped credential isolation pass; no arbitrary relay ID binding, duplicate printer records or accidental queue rebinding.
- [ ] Label content, child/parent names, host/printer identifiers, Keychain tokens, spool, diagnostics, backup and log data audited against [inventory](APP-PRIVACY-INVENTORY.md).
- [ ] Approved legal entity, privacy/support contacts and **real public URLs**; App Privacy questionnaire + privacy manifest independently approved.
- [ ] Truthful [metadata](STORE-METADATA-DRAFT.md), [FAQ](SUPPORT-FAQ-DRAFT.md), [review notes](APP-REVIEW-NOTES-DRAFT.md) and [screenshots](SCREENSHOT-SHOTLIST.md) reviewed.

## Apple / entitlement / devices

- [ ] [Printer #49](https://github.com/favorchurch/favor-printer/issues/49): Apple approves Zebra DriverKit entitlement for signed distribution; provisioning/profile/extension IDs verified.
- [ ] TestFlight **distribution-signed build** installs, enables extension and actually sends a physical label to intended Zebra; avoid confusing this with developer-signed synthetic evidence.
- [ ] Supported iPadOS version, iPad models, USB/data cables and Zebra models confirmed, not assumed from MNL test.
- [ ] Reviewer-safe **functioning** hardware-enabled or explicitly approved alternative demo exists; no false DEBUG/fake-relay claims.
- [ ] Correct App Store Connect team/account holder/legal seller, export/privacy fields, screenshot sizes and **unlisted listing request/Apple approval** verified.
- [ ] Explicit authorized human approval to **submit for App Review** (separate from approval to publish).

## Cloud and operator end-to-end acceptance

- [ ] On a distinct RSVP web check-in station: actual authorized RSVP web check-in → cloud queue → correctly enrolled iPad host → real Zebra **child and parent labels** → report/ack, no duplicates.
- [ ] Identity-preserving authorized Mac→iPad handover tested against the **same** UUID, campus, check-in pairings, queued jobs, explicit old-owner stop.
- [ ] USB loss/replug, Wi-Fi loss, app switch, lock, reboot, revoke/re-enroll and stale claim recovery tested against actual cloud; **sending/ambiguous never blindly replay**.
- [ ] Per-campus MNL, BNE and SEL hardware models, assigned owners, setup checklist and fallbacks verified individually.
- [ ] Native Rock/Mac operational fallback and rollback rehearsed with the campus leads, no live user surprise.
- [ ] Human owners explicitly authorize **publication and operational campus cutover** *separately*, after accepted print proof.

## Current evidence without overclaiming

- Merged [PR #43](https://github.com/favorchurch/favor-printer/pull/43): USB DriverKit relay-only implementation.
- Printer [#23](https://github.com/favorchurch/favor-printer/issues/23): development-signed synthetic M2 iPad/ZD421 test, **not** live cloud acceptance.
- Printer [#44](https://github.com/favorchurch/favor-printer/issues/44): F5/F9/F6 fixed in PR #56; UI-test timing remains to verify.
- RSVP [#624](https://github.com/favorchurch/rsvp.favor.church/issues/624): all rollout and release boundaries.

Record exact evidence URLs, build IDs, who approved and timestamps in the linked issues. Checkboxes above stay unchecked until an independent verifier signs off.
