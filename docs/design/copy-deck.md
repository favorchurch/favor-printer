# Favor Printer Copy Deck

## Voice and Mechanical Guidelines

This copy deck defines every user-facing string across the Favor Printer desktop application and menu bar tray.

All copy complies strictly with Favor Church Manila standards (`speak-like-favor` and `dashboards-like-favor`):
- **Friendly Peer Voice:** Warm, human, helpful, confident, and direct. We sound like a knowledgeable teammate standing beside the volunteer.
- **No Stiff Jargon / Christianese:** Clear, functional descriptions of technical and hardware states.
- **Zero Em Dashes:** Never use em dashes (`—`). Use commas, colons, semicolons, periods, or parentheses.
- **No Sentences Starting with 'And':** Ensure varied, natural sentence structures.
- **No Use of 'fam':** Excluded entirely.
- **Oxford Comma:** Always applied on lists of three or more items.
- **Numerals for Digital Copy:** Digits used for quantities, time, and numbered steps (`2 minutes`, `6-digit code`).
- **Clean Links:** No `https://`, `http://`, or `www` in visible copy.
- **Direct Invitations:** Confident calls to action without unnecessary filler.
- **Tone in Errors:** Truthful, patient, non-judgmental, and actionable. Volunteers are guided directly on what to check or whom to ask.

---

## 1. Application Setup Flow: 6 Steps and Sub-States

The setup window guides volunteers through onboarding their MacBook to print check-in badges for Sunday services.

### Step 1: Welcome (`welcome`)
- **Eyebrow:** None (step count starts after the welcome screen)
- **Window Title (`h1`):** `Set up Favor Printer`
- **Lead Text:** `This app lets your Zebra label printer print check-in labels from Favor RSVP. Setup takes about two minutes.`
- **Overview List:**
  1. `Pick your printer`
  2. `Enter the code from an admin`
  3. `Print a test label`
- **Primary Action:** `Get started`

---

### Step 2: Printer Setup & Sub-States (`printer`)

#### 2A. No Printer Detected (`printer-none`)
- **Eyebrow:** `Step 1 of 5`
- **Window Title (`h1`):** `Plug in your Zebra printer`
- **Lead Text:** `Connect the printer to this Mac with its USB cable and turn it on. It can take a few seconds to show up.`
- **Error Banner (if previously failed with `printer_not_found`):** `We cannot see your Zebra printer. Check that it is turned on and plugged in, then try again.`
- **Primary Action:** `Look again`

#### 2B. Multiple Printers Connected (`printer-several`)
- **Eyebrow:** `Step 1 of 5`
- **Window Title (`h1`):** `Which printer is this?`
- **Lead Text:** `More than one Zebra is connected. Choose the one you want to print check-in labels on.`
- **Device Row Title:** `[Printer Model, e.g. ZD421-203dpi ZPL]`
- **Device Row Subtitle:** `Serial [USB Serial Number, e.g. D2J190800123]`
- **Action:** Clicking a device selects it and proceeds to queue verification.

#### 2C. Printer Found but Queue Not Installed (`printer-no-queue`)
- **Eyebrow:** `Step 1 of 5`
- **Window Title (`h1`):** `Set up the printer`
- **Lead Text:** `Your Mac does not have this printer set up yet. Favor Printer can do it for you. macOS may ask for your password.`
- **Primary Action:** `Set up printer`

#### 2D. System Settings Fallback (`printer-fallback`)
*Triggered when macOS refuses automated queue setup or admin authentication fails.*
- **Eyebrow:** `Step 1 of 5`
- **Window Title (`h1`):** `Add the printer in System Settings`
- **Lead Text:** `macOS did not let Favor Printer set this up. You can add it yourself:`
- **Numbered Steps:**
  1. `Open System Settings, then Printers & Scanners.`
  2. `Click Add Printer, and choose the Zebra from the list.`
  3. `Come back here and choose Check again.`
- **Primary Action:** `Open Printers & Scanners`
- **Secondary Action:** `Check again`

#### 2E. Printer Ready (`printer-ready`)
- **Eyebrow:** `Step 1 of 5`
- **Window Title (`h1`):** `Printer ready`
- **Lead Text:** `[Printer Model, e.g. ZD421-203dpi ZPL] is connected and set up.`
- **Primary Action:** `Continue`

---

### Step 3: Admin Enrollment Code (`code`)
- **Eyebrow:** `Step 2 of 5`
- **Window Title (`h1`):**
  - Initial setup: `Enter your code`
  - Re-enrolling after revocation: `Enter a new code`
- **Lead Text:** `Ask an admin for a six-digit code from Favor RSVP. It only works for a short time.`
- **Field Label:** `Six-digit code`
- **Field Placeholder:** `000000`
- **Helper Hint (idle):** `Numbers only.`
- **Primary Action (idle):** `Connect`
- **Primary Action (submitting):** `Checking...`

#### Enrollment Error Messages:
| Error Code | User-Facing Banner String | Explanation & Action |
|---|---|---|
| `invalid_code` | `That code did not work. It may have expired. Ask an admin for a new one.` | Code was wrong or timed out. |
| `throttled` | `Too many tries. Wait a few minutes, then enter the code again.` | Rate-limited by security policies. |
| `disabled` | `Enrolling is turned off right now. Ask an admin for help.` | Event or station enrollment closed in RSVP. |
| `unreachable` | `Could not reach Favor RSVP. Check the internet connection and try again.` | Network down or WiFi captive portal blocking. |
| `printer_not_found` | `We cannot see your Zebra printer. Check that it is turned on and plugged in, then try again.` | Printer disconnected during enrollment. |
| `invalid_request` | `The app could not send that request. Update Favor Printer and try again.` | Malformed payload / outdated client. |

---

### Step 4: Laptop Connected (`connected`)
- **Eyebrow:** `Step 3 of 5`
- **Window Title (`h1`):**
  - Connected: `Connected`
  - Polling/Connecting: `Connecting...`
- **Lead Text:**
  - With laptop label: `This Mac is now [Laptop Label, e.g. Front Desk Laptop] in Favor RSVP.`
  - Without label: `This Mac is now connected to Favor RSVP.`
- **Status Pill:** Green dot + `Ready to print`
- **Primary Action:** `Print a test label`

---

### Step 5: Test Print Verification (`test-print`)
- **Eyebrow:** `Step 4 of 5`

#### 5A. Initial / Ready to Send
- **Window Title (`h1`):** `Print a test label`
- **Lead Text:** `Favor Printer will send one test label to your Zebra.`
- **Primary Action (idle):** `Print test label`
- **Primary Action (sending):** `Sending...`

#### 5B. Label Sent / Awaiting Physical Confirmation
- **Window Title (`h1`):** `Did a label come out?`
- **Lead Text:** `Favor Printer sent the label to the printer. That does not prove a label printed, so check the printer.`
- **Primary Action (Success Confirmation):** `Yes, a label came out`
- **Secondary Action (Failure Confirmation):** `No label came out`

#### 5C. Physical Failure Guidance (`no-label`)
- **Window Title (`h1`):** `Did a label come out?`
- **Error Banner:** `Check that the label stock is loaded and the printer light is steady, then try again.`
- **Primary Action:** `Try again`

#### Test Print Error Messages:
| Reason Code | User-Facing Banner String | Explanation & Action |
|---|---|---|
| `no_printer` | `No printer is ready. Plug in the Zebra and check the menu bar icon.` | USB cable disconnected. |
| `printer_not_ready` | `This printer is not ready yet. Wait a minute and try again. If it keeps happening, ask an admin to check that this printer is enabled in RSVP printing settings.` | Relay starting up or disabled in cloud. |
| `paused` | `Printing is paused. Choose Resume printing in the menu, then try again.` | Paused from tray menu. |
| `busy` | `The printer is busy with a label. Wait a moment, then try again.` | Print job currently spooling. |
| `failed` | `The test label could not be sent. Try again.` | Generic CUPS transport failure. |

---

### Step 6: Setup Complete (`done`)
- **Eyebrow:** `Step 5 of 5`
- **Window Title (`h1`):** `You are all set`
- **Lead Text:** `Favor Printer runs from the menu bar. Keep the lid open and the Mac plugged in during events.`
- **Operational Advisories (Bullet List):**
  - `Keep the lid open while printing. Closing the lid can stop labels from printing.`
  - `Keep this Mac connected to power so background sleep does not pause check-in.`
- **Primary Action:** `Finish`

---

## 2. Legacy Relay Migration Flow (`legacy`, `legacy-confirm`)

This flow appears when a MacBook has the previous background launchd relay service active.

### Legacy Relay Detected Screen (`legacy`)
- **Window Title (`h1`):** `Replace the old print relay`
- **Lead Text:** `An older print relay is still running on this Mac. If both ran, they could claim the same labels, so Favor Printer stays off until the old one is turned off.`
- **Safety Reassurance:** `Nothing is deleted, and no password or code is copied from the old relay.`
- **Failure Banner (if bootout failed):** `The old relay could not be turned off. Printing stays off. Ask an admin for help.`
- **Primary Action (normal):** `Move to Favor Printer`
- **Primary Action (after error):** `Try again`

### Legacy Migration Confirmation (`legacy-confirm`)
- **Window Title (`h1`):** `Turn off the old print relay?`
- **Lead Text:** `Favor Printer will stop the old relay now and keep it from starting when you log in. Labels printed by the old relay stop until you finish setting up here.`
- **Safety Reassurance:** `Favor Printer checks that the old relay is gone before it starts printing.`
- **Primary Action (idle):** `Turn off old relay`
- **Primary Action (processing):** `Turning it off...`
- **Secondary Action:** `Cancel`

---

## 3. Persistent Standalone Screens

### Removed / Revoked Laptop Screen (`revoked`)
- **Window Title (`h1`):** `This laptop was removed`
- **Status Pill:** Red dot + `This laptop was removed. Ask an admin for a new code.`
- **Lead Text:** `Ask an admin for a new code. Printing is off until you enter it.`
- **Primary Action:** `Enter a new code`

### Main Status Window (`status`)
- **Window Title (`h1`):** `Favor Printer`
- **Status Pill:** Current status pill (Color dot + Headline)
- **Detail Text:** Current status detail line (if any)
- **Version Subtitle:** `Version [x.y.z] ([Channel])` (e.g., `Version 0.1.0 (Stable)` or `Version 0.1.0 (Preview)`)
- **Update Channel Values:**
  - `stable` → `Stable`
  - `preview` → `Preview`
- **Update Status Lines (`UpdateState`):**
  - `idle`: `Up to date`
  - `checking`: `Checking for updates...`
  - `downloading`: `Downloading update...`
  - `ready`: `Update ready. Restart to apply.`
  - `error`: `Update check failed.`
- **Primary Action:** `Close`

---

## 4. macOS Menu Bar Tray Surfaces

### Tray Tooltip
- `Favor Printer: [Status Headline]`

### Session Print Counts
- Format: `Labels this session: {sent} sent, {failed} failed[, {ambiguous} to check]`
- Example 1: `Labels this session: 142 sent, 0 failed`
- Example 2: `Labels this session: 84 sent, 2 failed, 1 to check`

### Update Status Items
- Idle: `Check for updates`
- Checking: `Checking for updates...`
- Downloading: `Downloading an update...`
- Ready: `Update {version} ready. It installs when you quit.` (or `An update is ready. It installs when you quit.`)
- Error: `Update check failed. Try again`

### Tray Menu Actions
- Setup / Migration trigger:
  - When legacy relay is active: `Move to Favor Printer...`
  - When revoked: `Enter a new code...`
  - Incomplete setup: `Finish setup...`
  - Unenrolled: `Set up Favor Printer...`
- Printing Controls:
  - When active: `Pause printing`
  - When paused: `Resume printing`
- Verification: `Test print...`
- Operational Warnings Submenu: `Keep printing`
  - Items reflect power/lid status, e.g.: `Keep the lid open while printing. Closing the lid can stop labels from printing.`
- Preferences:
  - Checkbox: `Open at login`
  - Submenu: `Update channel` (`Stable`, `Preview`)
- App Information & Exit:
  - App Version: `Favor Printer {version}`
  - Quit: `Quit Favor Printer`
