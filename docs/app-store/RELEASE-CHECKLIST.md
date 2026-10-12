# Favor Printer: Apple deployment and review gates

**Not ready for submission.** Complete each applicable gate using evidence from the actual shipping binary. Existing macOS direct-download rollout remains separate.

## Gate A — decide the product and distribution

- [x] Product role [Option C](https://github.com/favorchurch/rsvp.favor.church/issues/627): **one native iPad app with RSVP check-in and printer-hosting** (decision locked; implementation not delivered).
- [ ] Approve [first App Store release gate](https://github.com/favorchurch/rsvp.favor.church/issues/630): dual-role at debut or staged delivery of both capabilities in the same app.
- [ ] Record results of [hardware and Mac sandbox research](https://github.com/favorchurch/rsvp.favor.church/issues/625).
- [ ] Approve [Apple distribution](https://github.com/favorchurch/rsvp.favor.church/issues/628): public, unlisted, Apple Business Custom App, MAS, or continuing Mac direct download.
- [ ] Confirm who owns Apple Developer organization, App Store Connect permissions and release approval.

## Gate B — safe operational onboarding

- [ ] [Atomic RSVP printer-to-host enrollment](https://github.com/favorchurch/rsvp.favor.church/issues/623) works for new and existing Zebra.
- [ ] [Human-friendly printer and laptop names](https://github.com/favorchurch/rsvp.favor.church/issues/629) are editable from RSVP; the same cloud names update from [Favor Printer](https://github.com/favorchurch/favor-printer/issues/16).
- [ ] No manually typed relay ID or manually created placeholder printer in the ordinary setup flow.
- [ ] Enrollment or replacement keeps original printer UUID, campus, kiosk pairing and queued jobs.
- [ ] Cloud-routed test print uses the same logical printer UUID as live RSVP check-in; local test alone is not green.
- [ ] USB disconnect, offline, conflicts, revoked credentials, queued-backlog warning, sending/ambiguous print delivery verified.
- [ ] Real Kids child + parent labels printed on MNL Zebra through RSVP check-in.
- [ ] Fallback process documented and Sunday Tech captain trained.

## Gate C — correct signed platform binaries

**Current Mac direct-download route**
- [ ] Keep verified Developer ID signing/notarization, hardened runtime, GitHub DMG/ZIP and stable/preview updates.
- [ ] Fresh Mac install arm64 and x64, update from previous version, and Gatekeeper behavior physically checked.
- [ ] Follow [existing release workflow](../RELEASING.md), including protected secrets, draft release and maintainer approval.

**Mac App Store (only if selected)**
- [ ] Prove a sandboxed Mac App Store build can use required Zebra discovery/CUPS printing safely; current app uses unsandboxed lp/lpadmin.
- [ ] Use appropriate MAS signing, entitlements/provisioning, Mac App Store update channel and sandbox/container paths.
- [ ] Test the sandboxed build on a clean Mac with the actual USB Zebra; DMG notarization is not sufficient.

**iPadOS — dual-role target locked; implementation pending**
- [ ] Native iPadOS binary exists with correct bundle ID/deployment minimum and responsive orientation.
- [ ] Prove hardware/network printing method **because hosting is in scope**; no assumption that macOS Electron/CUPS runs on iPad. Use only transport supported by actual Zebra and iPadOS.
- [ ] Native RSVP check-in and printer-host enroll/print on actual iPad hardware, network recovery, auth, printer assignment, offline behavior and cloud printing tests pass.
- [ ] Other iPad check-in clients can submit real cloud jobs to an enrolled host iPad. Verify foreground, screen lock, app switching and reboot availability, and whether a single iPad can check in while hosting.
- [ ] TestFlight acceptance, relevant local-network permissions and accessibility verified.

## Gate D — App Store account and compliance

- [ ] Account Holder has accepted Apple's latest agreements; correct seller organization, app record(s), bundle IDs and SKUs.
- [ ] Signing/provisioning/private keys managed securely outside Git.
- [ ] Final privacy policy approved by responsible legal/organizational owner and live on public HTTPS URL.
- [ ] Apple's app privacy questionnaire reviewed against code, logs and third parties for every platform.
- [ ] Underlying child/family data protection, consent/notice responsibilities, incident handling and retention validated.
- [ ] Age rating, export compliance, territories, content rights, screenshot/icon copyrights and accessibility reviewed.
- [ ] Metadata and screenshots are factual and match the actual uploaded version; include 13-inch iPad and/or Mac sizes.
- [ ] Support URL, FAQ, issue escalation and monitored contact live.
- [ ] Reviewer demo account and synthetic data work without real kids' check-ins.

## Gate E — validation, submission and rollout

- [ ] Automated tests: OTP reuse, idempotent binding, concurrent enrollment, serial conflict, rename, permission boundaries, print queue and ambiguous job rules.
- [ ] End-to-end Mac + real Zebra check, kiosk check-in, multiple devices to one shared printer.
- [ ] Real iPad TestFlight and UI/accessibility checks where relevant.
- [ ] Mac App Store hardware/sandbox check if MAS selected.
- [ ] Reviewer notes and privacy answers quality checked by a different person.
- [ ] Authorized release owner explicitly approves App Review submission.
- [ ] Correct build uploaded to App Store Connect; review credentials sent through secure fields.
- [ ] Review approval recorded; **release/publishing is a separate approval**.
- [ ] Staged release monitoring, incidents, rollback/fix-forward and Sunday fallback owner assigned.
- [ ] Public docs and support contact updated to shipped feature state.

## References

Apple app record: https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app  
Apple App Privacy: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy  
Apple screenshots: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications  
Unlisted distribution: https://developer.apple.com/support/unlisted-app-distribution/  
Favor Printer release guide: [RELEASING.md](../RELEASING.md)