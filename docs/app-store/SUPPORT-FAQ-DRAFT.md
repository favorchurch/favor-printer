# Favor Printer: volunteer support FAQ (working draft)

**Do not publish features that have not shipped.** Names, cloud-ready tests and one-step onboarding below include planned improvements tracked in GitHub.

## Locked decisions this FAQ reflects

- **Name:** **Favor Printer** on Mac and iPad, with no retired working titles in any answer.
- **iPad v1:** native Rock event and Kids **check-in only**, **online-only**.
- **Printer Host:** a **later update** of the same iPad app, not claimed now.
- **Distribution:** **unlisted**, shared by **direct link** only.
- **Pilots:** controlled pilots run concurrently at **MNL, BNE and SEL**.
- **Devices:** personally owned iPads need an **approved check-in device grant**.

## What is Favor Printer?

Favor Printer is a Mac menu-bar application that allows a connected, compatible USB Zebra label printer to receive jobs from Favor RSVP check-in. iPads/browsers can send check-in print jobs through a selected cloud printer; that does not itself make the iPad a USB printer host.

## What do I need to set up?

A supported Mac with the app, physical Zebra with labels/power/USB connected, reliable Internet and an authorized Favor RSVP setup code for the intended printer/campus. A check-in device needs its own correct cloud printer selection/pairing.

## How do volunteers get the iPad app?

The iPad app is **unlisted**: your church shares the approved **direct link** with you. It will not appear in App Store search. The first release is a controlled pilot at **MNL, BNE and SEL**, so expect the link from your campus team rather than a general announcement.

## Can I use my own iPad?

Yes, if an administrator **approves your device and grants it check-in access**. The download link and your RSVP login are not permission by themselves. An unapproved or lost iPad loses check-in access as soon as an administrator revokes its grant.

## Does check-in work without internet?

No. iPad v1 is **online-only**: while disconnected, the app shows a connection-required state and check-in is disabled. Nothing is queued to send later. If a check-in acknowledgement goes missing, the app checks the server's attendance before trying again so nobody is counted twice. Your campus fallback (the existing RSVP web flow) is rehearsed for outages.

## Why does a printer say “USB Printer” or my Mac say “Unnamed laptop”?

Those are generic labels from current enrollment. The improvement will offer editable friendly names for both the physical printer and its host laptop in Favor Printer and RSVP. Until this is in the shipping version, do not guess or change relay IDs to rename a device.

## Why did the app's test label print but a real check-in did not?

Local printing only tests the cable/queue. A cloud-routed check-in uses a **logical printer record and specific enrolled relay ID**; these may still point to a different record. Verify campus, printer UUID, live host binding and cloud job queue, then escalate. This failure is documented in [RSVP #623](https://github.com/favorchurch/rsvp.favor.church/issues/623).

## What should the new setup flow be? (proposed; not yet released)

1. Open Favor Printer and select the USB Zebra found by the Mac.
2. Name the Mac and printer in human-friendly terms, such as “MNL Zebra 2”.
3. Follow the RSVP one-time enrollment invitation tied to the intended cloud printer and campus.
4. Let the app automatically enroll the relay and confirm matching cloud identities.
5. Run a **server-routed test** and verify a label physically emerges.
6. Select/pair the same cloud printer on the RSVP check-in device. No manual relay ID should be needed.

## Printer disconnected, laptop replaced or device offline?

Check power, cable, Mac awake/login and network, then follow verified status guidance. Do not create a new cloud printer just because a Mac was replaced. Re-enroll the **existing** printer deliberately with an authorized operator and preserve UUID, campus, device pairings and queued jobs. Warn the captain before binding a recovered relay with older queued labels.

## What if a label already printed or the queue says “Ambiguous”?

Avoid automatic repeat printing. A label could have physically printed before the app lost confirmation. Use the supported operator reprint/review flow only after checking the job status. Attendance and printing are separate operations.

## Can the iPad replace the Mac printer host?

**Not in v1.** The iPad app launches as **check-in only, online only**, printing through the proven Mac/CUPS relay. **Printer Host** is a **later update** of this same app, released only after the printer hardware and iPadOS lifecycle tests pass. Only specifically compatible Zebra models and connections will be supported then. Do not promise hosting in v1, and do not describe direct iPad USB printing as available.

## Who should I contact?

**Proposed setup/support page:** https://rsvp.favor.church/printer  
**Proposed contact:** techteam@favor.church: [CONFIRM monitored inbox / Sunday escalation owner].

For a support request provide campus/service time, app version, friendly device names, printer model and status, and relevant print job ID. **Do not** send child attendee label content, security QR codes, relay tokens or live enrollment codes in a public ticket.

Before publishing this FAQ, test these exact steps with a fresh installation and authorize the support contact.
