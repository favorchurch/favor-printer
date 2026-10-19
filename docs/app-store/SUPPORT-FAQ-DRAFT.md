# Favor Printer iPad — support FAQ (draft)

**What is Favor Printer?** An iPad (or Mac) printer host for labels requested by Favor RSVP. **All check-in is done in the RSVP website**, usually on a separate device. The host app does not search for attendees or record attendance.

**Which printers work?** Start with physically verified USB Zebra models and DriverKit extension support. The development-signed M2 iPad + ZD421 synthetic result does not prove every Zebra model, USB adapter or TestFlight profile. Confirm campus inventory and cable before promising compatibility.

**Can the iPad be locked or used for another app while printing?** **No.** Keep Favor Printer in the foreground with the screen awake; use Guided Access and Auto-Lock Never. Switching apps or locking pauses cloud job claiming. The internal audio experiment is not an App Store feature.

**How do I set it up?** Ask an authorized printing admin to use **Set up printing** in RSVP. Connect USB Zebra, enable the DriverKit extension, enroll with the expiring code for the **intended printer UUID**, confirm campus and host/printer names, then run a **cloud-routed physical test** (not only a local test).

**What if a printer says in use elsewhere?** Do not create a duplicate printer, copy relay IDs or reuse someone else's credential. Ask the authorized RSVP printing admin to perform a verified, scoped Mac→iPad handover/re-enrollment with a backlog preview.

**What if Wi-Fi or USB disconnects?** Reconnect the network/USB, review readiness and ask a printer admin before clearing queues. A job that might have reached the printer is **ambiguous**; it must not be silently retried. Label replacement is a supervised operational decision.

**Can we edit printer names?** Friendly names are managed against canonical RSVP records; renaming is not a printer/relay ID change. #629 and Printer #16 retain final real-device sync acceptance.

**Can I use a Mac fallback?** Yes, but switching the **same canonical printer UUID** between hosts needs an authorized, queue-safe handover. Coordinate with your campus lead.

**Is it published in the App Store yet?** No approved unlisted distribution link is recorded here. Development/internal builds are not a final Apple/TestFlight approval. Ask the release owner for current permitted distribution and privacy/support URLs.

**Where do I get help?** [CONFIRM OFFICIAL SUPPORT URL/CHANNEL BEFORE APP REVIEW]. Never send real ZPL/children's labels, working OTPs or credentials in a support chat.
