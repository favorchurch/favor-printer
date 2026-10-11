# Apple App Review notes — DRAFT ONLY

These notes must be matched to the exact signed build, distribution type and hardware tested before being entered in App Store Connect. **Do not paste or submit unchanged.** A real, functional reviewer demo is required; this document does not create one.

## Intended audience

Favor Printer is an operational utility for authorized Favor Church staff and volunteers who use Favor RSVP check-in printers. The current Mac app runs a local CUPS-based Zebra print relay; a planned native iPad app has a **locked dual role**: RSVP check-in and hosting compatible Zebra print jobs. Its hardware implementation is still unverified.

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

## iPad review notes — dual role decided, actual demo blocked on implementation

**Product decision:** [one native iPadOS app for both check-in and printer hosting](https://github.com/favorchurch/rsvp.favor.church/issues/627#issuecomment-6106334709). The following walkthrough is a **plan**, not a shipped feature:

1. Reviewer installs the native iPad app with safe, least-privileged demo credentials.
2. Reviewer performs an authorized synthetic check-in, which uses existing RSVP attendance and print-job semantics.
3. Reviewer opens **Printer Host**, enrolling an explicitly supported printer and seeing the canonical cloud printer identity, name and campus without entering a relay ID.
4. A second test device routes a cloud print job to this host; the test must have a meaningful no-hardware demo only if such simulation has been built and accurately labeled.
5. Reviewer sees host connected/disconnected status and safe failure/recovery states. Demonstrate one-iPad combined check-in + host only where proven under actual iPadOS lifecycle constraints.

**Pending:** [First-release completeness versus staged hosting](https://github.com/favorchurch/rsvp.favor.church/issues/630), exact Zebra compatibility, foreground/lock behavior, genuine hardware tests, reviewer-accessible sandbox and approved App Store wording. Never advertise hosting in a staged check-in-only binary.

## Submission checks

- [ ] Reviewer credentials tested from a fresh device
- [ ] Demo environment contains only synthetic records and is accessible during review
- [ ] App isn't hidden behind an unavailable private network without explanation and a legitimate demo
- [ ] Mac and iPad platform notes match actual features
- [ ] Support contact monitored, account accessible, hardware constraints clear
- [ ] No unverified sandbox, background, Bluetooth, AirPrint or USB claims

Apple review guidelines: https://developer.apple.com/app-store/review/guidelines/