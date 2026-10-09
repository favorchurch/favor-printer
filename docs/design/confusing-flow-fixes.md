# Favor Printer: Confusing-Flow Audits and Fixes

This document records the user-experience issues identified during volunteer usability observations, explains exactly what confused volunteers, and details the explicit design and copy changes implemented to eliminate friction while staying strictly within existing architectural seams.

---

## Issue 1: Silent Test Print Ambiguity

### What Confused Volunteers
When volunteers reached the test print step in earlier iterations, clicking "Print a test label" reported success as soon as the print command was queued into the local CUPS spooler. Volunteers assumed this meant the physical printer had actually output a label. In reality, Zebra thermal printers may be out of label stock, jammed, powered off, or paused on the hardware front panel. Volunteers would click "Finish", walk away, and only discover during rush-hour Sunday check-in that nothing was printing.

### What Changed
- **Explicit Two-Phase Physical Verification Screen:** The test print step was refactored into a clear two-step flow (`test-print`). Once the software hands the label to the spooler, the screen transforms from "Print a test label" to an explicit inquiry:
  - **Heading:** `Did a label come out?`
  - **Explanatory Lead:** `Favor Printer sent the label to the printer. That does not prove a label printed, so check the printer.`
  - **Distinct Affirmative/Negative Actions:**
    - Primary Button: `Yes, a label came out` (advances to Done).
    - Secondary Button: `No label came out` (triggers inline diagnostic assistance).
- **In-Place Diagnostic Guidance:** Clicking `No label came out` immediately presents actionable physical troubleshooting:
  - `Check that the label stock is loaded and the printer light is steady, then try again.`
- **Architectural Seam Preservation:** Uses the existing `confirmTestPrint` and `requestTestPrint` IPC methods. No backend API or protocol changes were needed.

---

## Issue 2: Abrupt Legacy Relay Takeover Fear

### What Confused Volunteers
When migrating from the legacy background launchd relay script to Favor Printer, volunteers were presented with a single generic confirmation or automatic takeover. Non-technical volunteers worried that clicking "Move to Favor Printer" would delete existing files, wipe church check-in configurations, or break the setup right before Sunday service. Furthermore, volunteers did not understand why Favor Printer refused to print while the old relay was still active.

### What Changed
- **Clear Explanation of the Dual-Relay Conflict:**
  - Screen copy explicitly explains the mechanics: `An older print relay is still running on this Mac. If both ran, they could claim the same labels, so Favor Printer stays off until the old one is turned off.`
- **Safety Reassurances:**
  - Prominent hint copy ensures peace of mind: `Nothing is deleted, and no password or code is copied from the old relay.`
  - Migration confirmation screen adds: `Favor Printer checks that the old relay is gone before it starts printing.`
- **Two-Step Confirmation Safety Gate:**
  - Screen 1 (`legacy`): Educational overview and "Move to Favor Printer" button.
  - Screen 2 (`legacy-confirm`): Explicit modal dialogue ("Turn off the old print relay?") with separate primary "Turn off old relay" and escape "Cancel" options.
- **Architectural Seam Preservation:** Operates purely within the renderer local state machine (`confirmingMigration`) and the existing `migrateLegacyRelay()` main IPC handler.

---

## Issue 3: Cryptic Enrollment Code Failures

### What Confused Volunteers
When an admin-generated six-digit enrollment code failed, volunteers previously saw generic error messages (e.g. "Network error" or "Enrollment failed"). Volunteers did not know whether they had mistyped the number, whether the laptop was offline, whether their venue coordinator gave them an old code, or whether the printer was unplugged.

### What Changed
- **Distinct, Actionable Error Copy per Failure Mode:** Every server refusal is mapped to a friendly, actionable string that directs the volunteer to the exact remedy:
  - `invalid_code` → `That code did not work. It may have expired. Ask an admin for a new one.` (Clarifies that codes are short-lived).
  - `throttled` → `Too many tries. Wait a few minutes, then enter the code again.` (Prevents panic and frantic re-typing).
  - `disabled` → `Enrolling is turned off right now. Ask an admin for help.` (Clarifies that the admin controls enrollment availability).
  - `unreachable` → `Could not reach Favor RSVP. Check the internet connection and try again.` (Points directly to local Wi-Fi / connectivity).
  - `printer_not_found` → `We cannot see your Zebra printer. Check that it is turned on and plugged in, then try again.` (Prevents attempting enrollment without a physical printer attached).
  - `invalid_request` → `The app could not send that request. Update Favor Printer and try again.`
- **Input Hygiene & Visual Guidance:**
  - Code entry enforces 6 numeric digits with `cleanCodeInput`, centered 32px tabular digits, and auto-disables submission until 6 valid digits are entered.
- **Architectural Seam Preservation:** Mapped to the existing `EnrollResult` union type in `app/src/shared/ipc.ts`.

---

## Issue 4: CUPS Queue Setup Permissions Confusion

### What Confused Volunteers
When plugging in a brand new Zebra printer, macOS requires creating a CUPS raw print queue. If macOS showed an admin password prompt or if the automated lpadmin queue setup failed, the app previously reported a generic failure. Volunteers thought the printer was broken.

### What Changed
- **Two-Stage Guided Setup with Graceful Fallback:**
  - **Stage 1 (`printer-no-queue`):** Explains that macOS needs setup: `Your Mac does not have this printer set up yet. Favor Printer can do it for you. macOS may ask for your password.`
  - **Stage 2 (`printer-fallback`):** If macOS permissions or policy prevent automated queue configuration (`setUpRefused: true`), instead of dead-ending, the app displays a clear 3-step manual walk-through:
    1. `Open System Settings, then Printers & Scanners.`
    2. `Click Add Printer, and choose the Zebra from the list.`
    3. `Come back here and choose Check again.`
  - Actions include a direct link `Open Printers & Scanners` (which opens the native macOS settings pane via shell) and `Check again`.
- **Architectural Seam Preservation:** Utilizes existing `setUpPrinter` response boolean (`ok: false` -> sets `local.setUpRefused`) and `openPrinterSettings` IPC.

---

## Summary of Seams Preserved

All confusing-flow improvements strictly adhere to established contract seams:
1. **No Backend API Alterations:** RSVP cloud protocols and heartbeat contracts remain 100% untouched.
2. **No Data Shape Mutations:** All snapshot types (`AppSnapshot`, `StatusSummary`, `JobCounts`) and IPC signatures are preserved.
3. **No Unilateral Authority Changes:** Administrative enrollment codes, permission checks, and CUPS device handling follow existing main process services.
