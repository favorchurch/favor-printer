# Apple screenshot shotlist and verification

**Assets are not yet captured.** All screenshots must come from a tested build and show **synthetic** volunteers, family and attendee details. Never include real children, phone numbers, tokens, working OTPs, security QR codes or private cloud identifiers in public imagery.

## Locked decisions this shotlist reflects

- **Name:** **Favor Printer** on Mac and iPad, with no retired working titles in any caption or frame.
- **iPad v1:** native Rock event and Kids **check-in only**, **online-only**; show the connection-required state rather than any offline queue.
- **Printer Host:** a **later update** of the same iPad app, so no hosting frames are captured now.
- **Distribution:** **unlisted**, shared by **direct link** only.
- **Pilots:** controlled pilots run concurrently at **MNL, BNE and SEL**.
- **Devices:** personally owned iPads appear only when they carry an **approved check-in device grant**.

## Apple requirements to recheck before upload

Current Apple screenshot guide: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications

- For iPadOS, at least **one 13-inch iPad screenshot**. As of 2026-10-11 the guide lists 2064 × 2752 or 2048 × 2732 portrait, and corresponding landscape dimensions 2752 × 2064 or 2732 × 2048.
- For a Mac App Store build, at least one **16:10 Mac screenshot**; supported choices include 1280 × 800, 1440 × 900, 2560 × 1600 or 2880 × 1800.
- One to ten per required device size; JPEG or PNG without alpha/transparency. Check actual current rules and locale before uploading.
- iPhone imagery is not needed unless a real iPhone target is supported.

## Mac suggested shots

1. **Choose your printer:** Favor Printer setup with real Zebra detected by the Mac.
2. **Connect to Favor RSVP:** guided enrollment destination and campus (no redeemable code displayed).
3. **Ready for check-in:** named laptop/printer, accurate cloud readiness and last test status.
4. **Manage connected printer:** edit friendly labels for the printer and its laptop, then reconnect.
5. **Recover from a problem:** useful unplugged/paused/conflicting-printer guidance.

The menu-bar utility may need its actual setup window opened for screen capture; no invented UI or composited “working” state.

## Native iPad shotlist: v1 is check-in only and online only

**Event and Kids check-in:** service and campus selection, synthetic family check-in, the assigned cloud printer and its status, and the printed parent/child label confirmation.

**Online-only states:** the connection-required state with check-in actions disabled, and the honest reconciliation message after a lost acknowledgement. Never show a queued or optimistic offline check-in.

**Device grant:** the approved-device state a personally owned iPad shows once its check-in device grant is active, and the revoked state afterwards. The direct link and login alone must never look like authorization.

**Web hand-off:** the clearly labelled hand-off to the existing web routes for volunteer roster, ticketing, registration and admin configuration.

**Printer Host:** a later update of this same app. Capture no hosting frames now, and never imply iPad USB printing or always-on hosting.

**Release-accuracy gate:** submit only screenshots of capabilities present and usable in the uploaded binary. The release is unlisted by direct link, and the first rollout is a controlled pilot at **MNL, BNE and SEL**; do not imply public availability in the imagery or captions.

## Production QA

- [ ] Store listing claims, screenshot features and submitted binary version align
- [ ] Captured from working app, not mockups submitted as screenshots
- [ ] All records, codes and names invented and non-sensitive
- [ ] Correct pixel dimensions, aspect ratios, orientation and opaque RGB imagery
- [ ] Accessibility and safe-area visible, no cropped critical controls
- [ ] Brand/design and app-icon rights approved
- [ ] Localization complete and actual support URLs visible only where appropriate
- [ ] Screenshot pack approved by release owner and refreshed after meaningful UI changes

The requested artifacts become possible once the platform role and app UI are settled.
