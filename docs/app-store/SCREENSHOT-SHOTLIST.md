# Apple screenshot shotlist and verification

**Assets are not yet captured.** All screenshots must come from a tested build and show **synthetic** volunteers, family and attendee details. Never include real children, phone numbers, tokens, working OTPs, security QR codes or private cloud identifiers in public imagery.

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
4. **Manage connected printer:** edit friendly labels and reconnect affordances — only when implemented.
5. **Recover from a problem:** useful unplugged/paused/conflicting-printer guidance.

The menu-bar utility may need its actual setup window opened for screen capture; no invented UI or composited “working” state.

## Native iPad shotlist — both capabilities locked, shipping claims gated

**Native Check-in:** service/campus selection, synthetic family check-in, selected cloud printer/status, print queue and graceful offline/reconnect.

**iPad Printer Host:** physically validated printer connection (supported Wi-Fi/TCP/IP/Bluetooth/AirPrint where appropriate), automatic cloud enrollment with readable device/printer names, readiness, physical cloud-routed test and recovery states.

**Combined journey:** show the same native app can expose both roles and one host iPad receives a job from another check-in iPad. Show one-device check-in+host only where supported by genuine iPadOS runtime tests.

**Release-accuracy gate:** If [first release is staged](https://github.com/favorchurch/rsvp.favor.church/issues/630), submit only screenshots of capabilities actually present and usable in that binary. Never imply iPad USB printing, always-on hosting or hardware support without evidence.

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