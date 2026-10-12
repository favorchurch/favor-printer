# Favor Printer: Apple deployment and review gates

**Not ready for submission.** Complete each applicable gate using evidence from the actual shipping binary. Existing macOS direct-download rollout remains separate.

## Locked decisions every gate below reflects

- **Name:** **Favor Printer** on Mac and iPad, with no retired working titles anywhere.
- **iPad v1:** native Rock event and Kids **check-in only**, **online-only**.
- **Printer Host:** a **later update** of the same iPad app, not claimed now.
- **Distribution:** **unlisted** App Store release shared by **direct link** only.
- **Pilots:** one concurrent controlled pilot wave at **MNL, BNE and SEL**.
- **Devices:** personally owned iPads need an **approved check-in device grant**.

## Gate A: locked product and distribution decisions

- [x] Product name [Favor Printer on iPad and Mac](https://github.com/favorchurch/rsvp.favor.church/issues/651#issuecomment-6111669883); no working titles in any document or listing.
- [x] First-release surface [locked to event and Kids check-in](https://github.com/favorchurch/rsvp.favor.church/issues/650#issuecomment-6111650756); `/team`, `/ticket`, `/rsvp` and `/admin` stay on the web routes.
- [x] [Online-only native v1](https://github.com/favorchurch/rsvp.favor.church/issues/649#issuecomment-6111615014): no offline check-in mutations or queue; show a connection-required state and reconcile server attendance before retrying.
- [x] [iPad printer hosting is a later update](https://github.com/favorchurch/rsvp.favor.church/issues/630#issuecomment-6110550319) of the same app; v1 does not claim it.
- [x] [Unlisted distribution by direct link](https://github.com/favorchurch/rsvp.favor.church/issues/628#issuecomment-6110595534) for the iPad app.
- [x] [Concurrent controlled pilots at MNL, BNE and SEL](https://github.com/favorchurch/rsvp.favor.church/issues/632#issuecomment-6110742440), with per-campus go/no-go and rollback.
- [x] [Personally owned iPads need an approved, revocable check-in device grant](https://github.com/favorchurch/rsvp.favor.church/issues/636#issuecomment-6111575395); link possession and login are not device authorization.
- [ ] Record results of [hardware, iPadOS lifecycle and Mac sandbox research](https://github.com/favorchurch/rsvp.favor.church/issues/625).
- [ ] Confirm who owns Apple Developer organization, App Store Connect permissions and release approval.

## Gate B: safe operational onboarding

- [ ] [Atomic RSVP printer-to-host enrollment](https://github.com/favorchurch/rsvp.favor.church/issues/623) works for new and existing Zebra.
- [ ] [Human-friendly printer and laptop names](https://github.com/favorchurch/rsvp.favor.church/issues/629) are editable from RSVP; the same cloud names update from [Favor Printer](https://github.com/favorchurch/favor-printer/issues/16).
- [ ] No manually typed relay ID or manually created placeholder printer in the ordinary setup flow.
- [ ] Enrollment or replacement keeps original printer UUID, campus, kiosk pairing and queued jobs.
- [ ] Cloud-routed test print uses the same logical printer UUID as live RSVP check-in; local test alone is not green.
- [ ] USB disconnect, offline, conflicts, revoked credentials, queued-backlog warning, sending/ambiguous print delivery verified.
- [ ] Real Kids child + parent labels printed on MNL Zebra through RSVP check-in.
- [ ] Fallback process documented and Sunday Tech captain trained.

## Gate C: correct signed platform binaries

**Current Mac direct-download route**
- [ ] Keep verified Developer ID signing/notarization, hardened runtime, GitHub DMG/ZIP and stable/preview updates.
- [ ] Fresh Mac install arm64 and x64, update from previous version, and Gatekeeper behavior physically checked.
- [ ] Follow [existing release workflow](../RELEASING.md), including protected secrets, draft release and maintainer approval.

**Mac App Store (only if selected)**
- [ ] Prove a sandboxed Mac App Store build can use required Zebra discovery/CUPS printing safely; current app uses unsandboxed lp/lpadmin.
- [ ] Use appropriate MAS signing, entitlements/provisioning, Mac App Store update path and sandbox/container paths.
- [ ] Test the sandboxed build on a clean Mac with the actual USB Zebra; DMG notarization is not sufficient.

**iPadOS: v1 is check-in only and online only; hosting is a later update**
- [ ] Native iPadOS binary exists with correct bundle ID/deployment minimum and responsive orientation.
- [ ] Native event and Kids check-in commits real attendance online; the connection-required state disables check-in mutations while offline, and an ambiguous acknowledgement reconciles against server attendance before any retry.
- [ ] Labels route through the existing cloud to Mac relay; no direct iPad USB or Printer Host claim exists in v1 copy or binary.
- [ ] Approved check-in device grants are enforced server-side for every device, including personally owned ones, with lost-device revocation and session/logout purge tested.
- [ ] Per-campus verified fallback rehearsed at MNL, BNE and SEL with the actually supported RSVP browser/Rock path.
- [ ] TestFlight acceptance, relevant local-network permissions and accessibility verified.
- [ ] Printer Host hardware and iPadOS lifecycle proof recorded **before** that later update is built, listed or submitted.

## Gate D: App Store account and compliance

- [ ] Account Holder has accepted Apple's latest agreements; correct seller organization, app record(s), bundle IDs and SKUs.
- [ ] Unlisted distribution request approved and the canonical direct link obtained before any sharing or QR handoff.
- [ ] Signing/provisioning/private keys managed securely outside Git.
- [ ] Final privacy policy approved by responsible legal/organizational owner and live on public HTTPS URL.
- [ ] Apple's app privacy questionnaire reviewed against code, logs and third parties for every platform, using the native API field list from [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/main/docs/native-api/v1.md) once it exists.
- [ ] Underlying child/family data protection, consent/notice responsibilities, incident handling and retention validated.
- [ ] Age rating, export compliance, territories, content rights, screenshot/icon copyrights and accessibility reviewed.
- [ ] Metadata and screenshots are factual and match the actual uploaded version; include 13-inch iPad and/or Mac sizes.
- [ ] Support URL, FAQ, issue escalation and monitored contact live.
- [ ] Reviewer demo account and synthetic data work without real kids' check-ins.

## Gate E: validation, submission and rollout

- [ ] Automated tests: OTP reuse, idempotent binding, concurrent enrollment, serial conflict, rename, permission boundaries, print queue and ambiguous job rules.
- [ ] End-to-end Mac + real Zebra check, kiosk check-in, multiple devices to one shared printer.
- [ ] Real iPad TestFlight and UI/accessibility checks where relevant, including the online-only connection-required state and device-grant revocation.
- [ ] Mac App Store hardware/sandbox check if MAS selected.
- [ ] Reviewer notes and privacy answers quality checked by a different person.
- [ ] Authorized release owner explicitly approves App Review submission.
- [ ] Correct build uploaded to App Store Connect; review credentials sent through secure fields; unlisted intent stated in review notes.
- [ ] Review approval recorded; **release/publishing is a separate approval**.
- [ ] Pilot rollout starts at MNL, BNE and SEL together with per-campus go/no-go, incident owner and rollback to the existing RSVP web flow.
- [ ] Broadening access beyond the pilots requires reviewed evidence and a new approval, regardless of the direct link.
- [ ] Public docs and support contact updated to shipped feature state.

## References

Apple app record: https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app  
Apple App Privacy: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy  
Apple screenshots: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications  
Unlisted distribution: https://developer.apple.com/support/unlisted-app-distribution/  
Favor Printer release guide: [RELEASING.md](../RELEASING.md)
