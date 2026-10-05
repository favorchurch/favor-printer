# Architecture

Favor Printer is a macOS menu-bar app. It makes a USB Zebra printer on a volunteer's Mac a
cloud-assigned check-in printer for [Favor RSVP](https://rsvp.favor.church): the cloud queues labels,
the app claims them and prints them through CUPS.

Where this document says "intended", the code for that part is tracked in
favorchurch/rsvp.favor.church#486 and favorchurch/favor-printer#1 and may not be merged yet. Check
`app/src/main` before relying on a detail marked that way.

## Process model

```
                      +------------------------+
 menu bar / setup --> |  main (Electron)       |  tray, windows, updater, login item,
                      |  app/src/main          |  CUPS (lp, lpadmin), legacy cutover
                      +-----+-------------+----+
         contextBridge IPC   |             |  utilityProcess message channel
                      +------v-----+  +----v------------------------+
                      |  preload   |  |  relay                        |
                      |  app/src/  |  |  vendor/relay/embedded.ts     |
                      |  preload   |  |  claims jobs, spools, prints, |
                      +------+-----+  |  reports outcomes             |
                             |        +----+-----------------+--------+
                      +------v-----+       | HTTPS           | lp -o raw
                      |  renderer  |       v                 v
                      |  setup UI  |   Favor RSVP API     CUPS queue -> Zebra (USB)
                      +------------+
```

| Process | Source | Responsibility |
| --- | --- | --- |
| main | `app/src/main` | Owns all state. Builds the tray menu and the setup window, derives the status shown to the volunteer, runs `electron-updater`, sets the login item, scans USB printers, creates the CUPS queue, and starts, pauses and stops the relay. |
| preload | `app/src/preload` | Exposes `window.favorPrinter` through `contextBridge`. This is the renderer's only way to reach the app. |
| renderer | `app/src/renderer` | The setup window. No Node access. It renders the `AppSnapshot` it is given and calls the API in `app/src/shared/ipc.ts`. It also runs standalone with a mock API (`pnpm preview:renderer`). |
| relay | `vendor/relay` | The print relay core, synced from the RSVP repository and never edited here. Main runs `embedded.ts` in an Electron `utilityProcess` and talks to it over a message channel (`start`, `pause`, `resume`, `stop`, `testPrint`, `printerAttached` in; events, test print results, errors and `stopped` out). It never reads `RELAY_*` environment variables when embedded. |

`app/src/shared` holds the constants and the IPC and status types used by main, preload and renderer.

### IPC

Every channel is listed in `IPC_CHANNELS` in `app/src/shared/ipc.ts`. Main validates every payload it
receives. The renderer never receives more than `AppSnapshot` (`app/src/shared/status.ts`): the version,
a status colour and text, the enrollment state, the laptop label, flags, update state, job counts, the
setup step, the detected printers and warnings. Main decides whether a setup step is reachable, so a
compromised or buggy renderer cannot skip enrollment.

### Printing path

1. The relay polls the RSVP API, authenticated with the relay token, and **claims** a job.
2. The job is written to the local spool (stage `claimed`), then written to the CUPS queue with
   `lp -d <queue> -o raw` (the `cups` transport, one queue for one physical printer).
3. Before bytes may reach the printer the spool entry moves to `sending`. If the app dies in that
   window the job is **never resent**: the outcome is unknown and is reported as such, because a
   duplicate name tag is worse than a missing one.
4. The outcome moves to `report` and is delivered to the cloud, retried until it is. Outcomes surface
   in the app as sent, failed or ambiguous counts. "Sent" means CUPS accepted the label, not that a
   label came out, which is why setup asks the volunteer "Did a label come out?".

The app is **not sandboxed** because it runs `lp` and `lpadmin`. It runs with the hardened runtime and
requests only `allow-jit` and `allow-unsigned-executable-memory` (`build/entitlements.mac.plist`): no
network, camera, microphone, `disable-library-validation` or dyld entitlements.

### Updates

`electron-updater` reads GitHub Releases of this repository (`electron-builder.yml`, `publish`). A
downloaded update installs when the app quits with no job in flight. See [RELEASING.md](RELEASING.md)
for channels and why rollbacks are fix-forward releases.

### Packaging

`pnpm build` bundles main, preload, relay, renderer and `electron-updater` into `dist/`, so the package
ships no `node_modules` and the target Mac needs no Node, pnpm, tsx or git. electron-builder produces a
DMG and a zip for `arm64` and `x64`. `LSUIElement` is set, so there is no Dock icon.

## Data

Intended layout, to be checked against `app/src/main`:

| Data | Where | Notes |
| --- | --- | --- |
| Enrollment and relay credentials | the app's data directory on the volunteer's Mac | Never sent to the renderer. Enrollment binds the Mac to the printer's USB serial. |
| Job spool | a `relay-spool` style directory inside the app's data directory | One JSON file per job, written to a temp name and renamed into place, so a crash leaves the old or the new entry, never a torn one. Locked so two relays cannot share it. |
| Settings (paused, open at login, update channel) | the app's data directory | Small preferences only. |
| CUPS queue | the system printer list | Created by the app through `lpadmin`. macOS may ask the volunteer to allow it. |
| Legacy relay | launchd label `church.favor.printrelay` | The pre-app relay this app replaces. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md). |

## Privacy

- **What leaves the Mac.** The app talks to the Favor RSVP API (HTTPS only; plain HTTP is accepted solely
  for `localhost` during development, because the bearer token travels in every request) and to
  GitHub Releases for updates. It sends job outcomes, a heartbeat and printer identity (model and USB
  serial). Do not add analytics or any other outbound traffic without updating this section.
- **What stays on the Mac.** Label contents (ZPL and the label data, which include attendee names)
  exist only in the `claimed` spool stage. After that stage the payload is stripped, so a lost laptop
  does not hold a history of name tags. Only ids, the claim token and outcomes remain until they are
  reported.
- **What the UI sees.** Counts, states and copy. Never names, ZPL or security codes.
- **Logs.** Keep label contents out of logs.

## Repository map

- `app/src/*`: the Electron app.
- `vendor/relay`: synced relay core, verified by `pnpm verify:vendor` and the `vendor-check` workflow.
- `build/`: packaging resources (entitlements).
- `scripts/`: build, renderer preview and vendor verification.
- `.github/workflows`: CI, vendor check, release and secret scan.
- `docs/`: this folder.
