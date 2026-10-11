# App Store listing copy — draft, not yet eligible for submission

## Identity and ownership

| Field | Proposed | Needed before submission |
| --- | --- | --- |
| App name | Favor Printer | Confirm availability; maximum 30 characters |
| Subtitle, Mac | Connect check-in printers | Maximum 30 characters |
| Seller | [VERIFY Apple Developer legal account name] | Match Apple records |
| Current Mac bundle ID | church.favor.printer | Verify the actual signed binary and platform record |
| Native iPad bundle ID | [DECIDE AFTER ARCHITECTURE] | Avoid assuming one shared record |
| Category | Utilities | Validate target platform |
| Default locale | English | Confirm availability/localization |
| SKU | [ASSIGN] | Unique App Store Connect internal identifier |
| Price | [CONFIRM] | Verify purchases/availability |
| Support URL candidate | https://rsvp.favor.church/printer | Must have real support contact and instructions |
| Privacy policy URL | [PUBLISH FINAL POLICY] | Public HTTPS, not this draft |
| Support contact candidate | techteam@favor.church | Verify monitored inbox and permission |
| Copyright | © 2026 [CONFIRM LEGAL SELLER] | Verify rights and entity |
| Availability | [PUBLIC / UNLISTED / CUSTOM / TERRITORIES] | https://github.com/favorchurch/rsvp.favor.church/issues/628 |

Apple limits app name and subtitle to 30 characters: https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/

## Candidate macOS listing

**Name:** Favor Printer  
**Subtitle:** Connect check-in printers

**Promotional text:** Connect compatible Zebra printers to Favor RSVP check-in and get clearer feedback when a printer needs attention.

**Description:**

Favor Printer helps authorized Favor Church teams connect supported Zebra label printers to their check-in workflow.

Using a Mac at the venue, your team can choose a connected printer, enroll the device with Favor RSVP, review connection status, and test printing. Check-in devices use cloud printer assignments to send labels to the correct on-site printer.

Favor Printer is intended for authorized ministry and event teams. A compatible printer, a Mac, and approved Favor RSVP access are required.

**Ship-only claims:** automatic cloud relay mapping, editable printer/laptop names, guided reconnection and remote-routed readiness testing must be included in the description only when their features are tested in the shipping build. Current app may not have them.

**Candidate keywords:** check-in,Zebra,labels,printer,church,event,volunteers. Validate Apple's character and keyword rules.

**What’s New:** [ACTUAL RELEASE VERSION] — [ONLY CONFIRMED FEATURES].

## Native iPad listing

**Not drafted as a feature claim yet.** If iPad is merely a check-in station, do not call it a direct USB Zebra printer relay. If it is an approved iPad printer host, document exact supported network/accessory devices and foreground/background limitations. Decide name, subtitle, descriptions, URL, bundle ID and screenshots after [the iPad role decision](https://github.com/favorchurch/rsvp.favor.church/issues/627).

## Remaining App Store Connect inputs

- [ ] Legal seller, agreement, app record, platform, bundle ID, SKU
- [ ] Exact tested release version, deployment target and minimum OS
- [ ] Name, subtitle, promotional text, keywords, localized screenshots, descriptions
- [ ] Age rating, content rights, encryption export compliance, pricing/territories
- [ ] Public privacy-policy URL and privacy answers
- [ ] Support page/contact and Apple reviewer instructions
- [ ] Apple-approved app icon and licensed screenshot assets
- [ ] Sign-off from product and account holder

References: https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app and https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/