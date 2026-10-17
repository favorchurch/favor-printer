# iPad setup guide: simulator verification

Screenshots of the in-app Setup guide and the Printer host status screen, captured on an iPad simulator (iPad Air 13-inch
(M4), portrait) against the mocked backend (`ios/FavorPrinter/UITestBackend.swift`). Open [index.html](index.html) for the
gallery.

Regenerate with `bash ios/scripts/capture-ux-screenshots.sh` and check with
`bash ios/scripts/check-ux-gallery.sh docs/verification/ipad-ux`.

## Verified on the simulator

Each screenshot is taken only after the test asserts the screen shows that state (page title, step state and, for the
status screens, the headline).

| File | Screen |
| --- | --- |
| `onboarding-welcome.png` | First screen of the Setup guide |
| `driver-not-running.png` | Printer driver step: printer seen, driver off, "Action needed", Settings steps |
| `printer-not-seen.png` | Connect the printer step: no printer, "Action needed", USB-C steps |
| `enrollment-help.png` | Enroll this printer step: one-time code field and the RSVP admin steps |
| `guided-access.png` | Guided Access and Auto-Lock step with Guided Access off |
| `background-on.png` | Background printing step, keep-alive on |
| `background-interrupted.png` | Background printing step after an audio interruption |
| `status-ready.png` | Status screen "Ready" (fake relay and fake printer, so it also shows the test-build controls) |
| `status-needs-attention.png` | Status screen "Needs attention", enrolled host with the driver not running |

Also verified there: the Setup guide page order and Continue/Back flow, the labels on the guide's controls, that finishing
the guide opens the status screen, and that a relaunch or an already-enrolled host skips the guide
(`OnboardingTests.swift`, `HostStatusUITests.swift`).

## Not verified until tested on the real iPad

The simulator has no DriverKit extension, USB, Guided Access or audio session contention. These states are injected by the
mock, so the following are unverified:

- Real driver toggle detection (the guide noticing Settings > Favor Printer > Drivers turned on or off).
- The iPad restart fix for "driver not running".
- Real USB replug timing (how long until the printer and driver show as seen and running).
- Real Guided Access detection.
- Real audio interruption (another app taking the audio, and the guide's interrupted state).
- Real enrollment and handover (the one-time code against RSVP, and handing over from a Mac or another host).
