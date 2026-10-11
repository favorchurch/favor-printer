# Apple App Review notes — DRAFT ONLY

These notes must be matched to the exact signed build, distribution type and hardware tested before being entered in App Store Connect. **Do not paste or submit unchanged.** A real, functional reviewer demo is required; this document does not create one.

## Intended audience

Favor Printer is an operational utility for authorized Favor Church staff and volunteers who use Favor RSVP check-in printers. The current Mac app runs a local CUPS-based Zebra print relay; a proposed iPad app has a separate, as-yet undecided role.

## App/build identity

- Platform: [Mac App Store / native iPadOS / both — pending decision]
- App version and build number: [FILL FROM ACTUAL UPLOADED BUILD]
- Bundle ID, minimum OS, locales and orientation: [VERIFY]
- Required server: Favor RSVP; account and campus permission required.
- Relevant printer: compatible Zebra label printer attached to a supported Mac in the present deployment; iPad printer hosting is NOT yet verified.

## Reviewer-safe access plan

Provide through Apple's secure review credential fields, **never GitHub**:
- A temporary, least-privilege demo account, expiration, credentials and correct campus access.
- A valid demo enrollment path, with safe test labels and no real attendee or child records.
- A reviewer-accessible test journey that exercises the app's core value even if the reviewer has no physical Zebra. A printer simulator/demo mode must be implemented, tested and honestly described before relying on it.
- A monitored review contact, response hours and any special setup steps.

**Do not** commit OTPs, relay bearer tokens, production QR codes, private child data, Apple API keys or account passwords.

## Proposed Mac verification walkthrough

1. Launch the app and inspect onboarding, status and supported hardware guidance.
2. Select a detected USB Zebra in the real device test environment.
3. Enroll with a reviewer-safe one-time code for the intended cloud printer record.
4. Verify the matching campus/host/printer identity and connection status.
5. Run a server-routed **synthetic** sample print and check actual physical output during hardware QA.
6. Show recoverable unplugged/offline or revoked-enrollment state.
7. Show laptop/printer renaming **only when** the feature has shipped and works in the submitted build.

For Apple reviewers lacking the hardware, provide a safe usable demonstration and explain which physical output functions need the printer; do not fake successful printing. If the demo is not viable, the review gate is blocked.

## iPad review notes — blocked pending role

[WRITE AFTER decision: https://github.com/favorchurch/rsvp.favor.church/issues/627 and real native app implementation.]

If the iPad is a check-in client, explicitly explain that the check-in app sends a cloud print request to a separate venue-connected relay; it does not turn the iPad into a USB printer host. If the iPad hosts a printer, prove supported hardware and OS permissions first.

## Submission checks

- [ ] Reviewer credentials tested from a fresh device
- [ ] Demo environment contains only synthetic records and is accessible during review
- [ ] App isn't hidden behind an unavailable private network without explanation and a legitimate demo
- [ ] Mac and iPad platform notes match actual features
- [ ] Support contact monitored, account accessible, hardware constraints clear
- [ ] No unverified sandbox, background, Bluetooth, AirPrint or USB claims

Apple review guidelines: https://developer.apple.com/app-store/review/guidelines/