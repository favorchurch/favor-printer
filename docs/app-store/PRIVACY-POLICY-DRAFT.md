# Favor Printer privacy policy — DRAFT FOR LEGAL REVIEW

**NOT A PUBLISHED POLICY. Do not link this draft as an App Store privacy policy.**

**Data controller / legal entity:** [CONFIRM LEGAL ENTITY]
**Privacy contact:** [CONFIRM MONITORED EMAIL]
**Approved public URL / effective date:** [PENDING LEGAL APPROVAL]

## What Favor Printer does

Favor Printer on iPad acts only as an authorized, dedicated **foreground USB Zebra printing relay** for Favor RSVP. RSVP web on another device manages check-in and supplies print jobs. The iPad app cannot browse attendees, change attendance or initiate child/family check-in.

## Data processed

The app receives enrollment and scoped printer-host credentials, printer ID/campus/name, hardware connection/status information and cloud print jobs. **ZPL labels may contain personal information about adults and children** needed for physical label printing. Job metadata and credentials are stored locally for recovery and access control. The app sends status, print attempts and results back to the RSVP service.

The label payload is persisted only while a job is `claimed`; after the app records a possible send, the payload is removed and the job is not silently replayed. This is an engineering rule, **not a guaranteed deletion/retention period**.

## Purpose and legal basis

[LEGAL TO CONFIRM] Operating authorized check-in label services, securing enrolled devices, troubleshooting jobs and meeting church operational/legal obligations. Confirm the applicable legal basis for personal/children's data in every campus jurisdiction before release.

## Recipients, safeguards and retention

RSVP cloud operators and authorized campus printing staff may receive needed status/job data; system USB printing transfers label data to the locally attached Zebra. Host bearer credentials use Keychain, the network uses HTTPS and a foreground host avoids silent unattended printing. [CONFIRM] Other processors, data residency, exact retention/backup periods, destruction/access workflows and breach response.

## Your choices and contact

[LEGAL TO CONFIRM] Access, correction and deletion requests, escalation, child-data safeguards and contact address.

## Approval gate

No final privacy-policy URL, App Store answers, legal assertions or personal data retention promise may be issued from this draft until approved by the responsible legal/privacy owner. See [privacy inventory](APP-PRIVACY-INVENTORY.md).
