# Favor Printer

Favor Printer is the macOS menu-bar app that turns a USB Zebra printer on a volunteer's Mac into a
cloud-assigned check-in printer for [Favor RSVP](https://rsvp.favor.church).

Download and setup steps for volunteers: https://rsvp.favor.church/printer

## Repository layout

- `app/` — the Electron app (work in progress, tracked in favorchurch/rsvp.favor.church#486).
- `vendor/relay/` — the print relay core, synced from the RSVP repository. Do not edit it here; changes
  land in the RSVP repository and arrive through the sync pull request.

Releases on this repository are the app's download and auto-update source.
