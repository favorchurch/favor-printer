# Apple App Review notes: DRAFT ONLY

These notes must be matched to the exact signed build, distribution type and hardware tested before being entered in App Store Connect. **Do not paste or submit unchanged.** A real, functional reviewer demo is required; this document does not create one.

## Locked decisions these notes reflect

- **Name:** **Favor Printer** on Mac and iPad, with no retired working titles anywhere in the notes.
- **iPad v1:** native Rock event and Kids **check-in only**, **online-only**; printing uses the existing cloud to Mac relay.
- **Printer Host:** a **later update** of the same iPad app, not demonstrated or claimed in this build.
- **Distribution:** **unlisted**, shared by **direct link** only; state that intent in the review notes.
- **Pilots:** controlled pilots run concurrently at **MNL, BNE and SEL**, each with its own go/no-go.
- **Devices:** personally owned iPads need an **approved check-in device grant**; reviewer access must not rely on an unmanaged device.

## Intended audience

Favor Printer is an operational utility for authorized Favor Church staff and volunteers who run RSVP check-in printers. The current Mac app runs a local CUPS-based Zebra print relay. The native iPad app for the first release is check-in only: volunteers check in families at Rock events and Kids check-in, online only, and labels print through the existing cloud to Mac relay.

## App/build identity

- Platform: native iPadOS for the unlisted first release; Mac App Store remains pending a sandbox printing feasibility result
- App version and build number: [FILL FROM ACTUAL UPLOADED BUILD]
- Bundle ID, minimum OS, locales and orientation: [VERIFY]
- Required server: Favor RSVP; account, campus permission and an approved check-in device grant required.
- Relevant printer: compatible Zebra label printer attached to a supported Mac in the present deployment; iPad printer hosting is a later update that is NOT in this build.

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

## iPad review notes: v1 check-in only, demo blocked on implementation

**Product decision:** [Favor Printer on iPad and Mac](https://github.com/favorchurch/rsvp.favor.church/issues/651#issuecomment-6111669883), with [first-release surface locked to event and Kids check-in](https://github.com/favorchurch/rsvp.favor.church/issues/650#issuecomment-6111650756) and [online-only v1](https://github.com/favorchurch/rsvp.favor.church/issues/649#issuecomment-6111615014). The following walkthrough is a **plan**, not a shipped feature:

1. Reviewer installs the native iPad app with safe, least-privileged demo credentials on a registered device.
2. Reviewer selects a service and performs one authorized synthetic check-in, which uses existing RSVP attendance and print-job semantics.
3. Labels route to the campus Mac printer relay; show the printer assignment and status the volunteer sees.
4. Turn off the network and show the connection-required state: check-in actions are disabled and nothing queues for later.
5. Show the revoked or off-campus state, and the clearly labelled hand-off to the existing web routes for volunteer roster, ticketing and registration.

**Printer Host is out of v1:** [iPad printer hosting is a committed later update of this same app](https://github.com/favorchurch/rsvp.favor.church/issues/630#issuecomment-6110550319), with the dual-role product decision recorded at [Option C](https://github.com/favorchurch/rsvp.favor.church/issues/627#issuecomment-6106334709). Do not demo, describe or screenshot it for this build, and do not imply the iPad prints directly over USB.

**Distribution and audience:** the release is [unlisted, shared by direct link](https://github.com/favorchurch/rsvp.favor.church/issues/628#issuecomment-6110595534); say so in the notes. The first rollout is a controlled pilot wave at **MNL, BNE and SEL** with per-campus go/no-go. Personally owned iPads participate only with an [approved check-in device grant](https://github.com/favorchurch/rsvp.favor.church/issues/636#issuecomment-6111575395).

**Pending:** hardware and iPadOS lifecycle results, reviewer-accessible demo data, approved App Store wording, and the audit mapping behind the native API data inventory (response fields are transcribed in the [App privacy inventory](APP-PRIVACY-INVENTORY.md) from [rsvp docs/native-api/v1.md](https://github.com/favorchurch/rsvp.favor.church/blob/8a560ce305ce25252e28ce92886ecb3b9fd995bc/docs/native-api/v1.md)). Never advertise hosting in a check-in-only binary.

## Submission checks

- [ ] Reviewer credentials tested from a fresh device
- [ ] Demo environment contains only synthetic records and is accessible during review
- [ ] App isn't hidden behind an unavailable private network without explanation and a legitimate demo
- [ ] Mac and iPad platform notes match actual features: check-in only, online only, no printer hosting
- [ ] Unlisted-by-direct-link intent stated in the review notes
- [ ] Support contact monitored, account accessible, hardware constraints clear
- [ ] No unverified sandbox, background, Bluetooth, AirPrint or USB claims

Apple review guidelines: https://developer.apple.com/app-store/review/guidelines/
