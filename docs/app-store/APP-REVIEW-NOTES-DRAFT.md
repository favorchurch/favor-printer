# App Review notes — iPad printer-host relay DRAFT

**NOT SUBMITTABLE YET.** Match this to the final signed binary and approved DriverKit entitlements. Do not supply production attendance or real children's labels to Apple.

## What the reviewer should expect

Favor Printer is the USB print-host companion of Favor RSVP, **not** a native check-in client. A campus printing administrator supplies an expiring one-time enrollment code for an existing printer. On a supported iPad with a Zebra USB printer, the app connects the DriverKit extension, displays status and delivers cloud-queued ZPL while in the **foreground**. Check-in is carried out on RSVP web on a *separate device*.

**Host app requirements:** supported iPadOS model, USB cable/data connection, approved Zebra USB VID (0x0A5F), installed/enabled DriverKit extension, live authorized RSVP cloud enrollment, network connection, foreground app. Mac fallback is operationally separate.

## Reviewer-safe walkthrough (blocked until provisioned)

1. Reviewer obtains **time-limited test-only** enrollment/instructions from the release owner, never committed in this repo. A synthetic RSVP printing test tenant/registry and safe cloud queue are needed.
2. Attach a **supported USB Zebra** and enable the app's DriverKit extension in Settings. Confirm that the app accurately reports driver and printer visibility.
3. Enroll with the test code; the app shows canonical campus, printer name and host state, without exposing bearer tokens.
4. From an authorized **separate RSVP web test session**, request a **synthetic** child/parent *sample* label pair. Confirm actual USB printing and correct job/queue outcome, including duplicate and ambiguous handling.
5. Switch away or lock the iPad: cloud job claims stop and readiness becomes paused/offline. Return to the foreground, reconnect network/USB as needed; already-sending/ambiguous labels must never be silently replayed.

**If a reviewer lacks Zebra hardware:** describe the hardware dependency candidly. A functioning Apple-approved reviewer demo path must be created and tested before submission; the DEBUG fake relay/transport is not in the Release build and must **not** be represented as a functional no-printer demo.

## Evidence still required

- Apple Zebra DriverKit entitlement grant + matching distribution provisioning profile, TestFlight-signed real device, USB print and App Review availability.
- Approved exact iPad hardware support and reviewer test credentials delivered securely.
- Screenshots from the final product (synthetic labels only), public support/privacy URLs, legal seller and App Store Connect access.
- Three-campus safety tests, Mac→iPad handover, ambiguous backlog recovery, release owner authorization.

**No production code, password, OTP, bearer, real attendance or child data belongs in this document.**
