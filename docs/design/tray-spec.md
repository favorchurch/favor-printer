# Favor Printer macOS Menu Bar Tray Specification

This document specifies the behavior, menu hierarchy, icon visual indicators, and complete state mapping for the Favor Printer macOS menu bar tray.

---

## 1. Architecture and State Mapping

The tray view is driven purely by the system state snapshot evaluated through `deriveStatus(inputs: StatusInputs)` in `app/src/main/services/statusSummary.ts`. 

The core operating principle: **Red outranks amber; amber outranks green. Green requires every single operational check to pass.**

Status values map directly to:
1. **Tray Menu Icon:** Dedicated template icons for Green (Ready), Amber (Attention Needed), and Red (Revoked / Removed).
2. **Tray Tooltip:** `Favor Printer: {headline}`.
3. **Menu Header:** Headline followed by contextual detail line (if present), laptop identifier label, and session counts.
4. **Contextual Action:** Dynamic setup, re-enrollment, or migration action.
5. **Print Controls:** Paused vs. Resume state.
6. **Background Preferences:** Open at login, updates, and channels.

---

## 2. Comprehensive `deriveStatus` State Table

Below is the state table covering every rule and priority in `deriveStatus`:

| Priority | Condition / Predicate | Dot / Tray Icon | Headline | Detail Line | Primary Menu Action | Action Enabled? |
|:---:|---|:---:|---|---|---|:---:|
| **1** | Laptop token revoked (`inputs.revoked \|\| relay.cloud === "revoked"`) | **Red** | `This laptop was removed. Ask an admin for a new code.` | *None* | `Enter a new code...` | Yes |
| **2** | Legacy launchd relay still running (`inputs.legacyRelayLoaded`) | **Amber** | `The old print relay is still running` | `Move to Favor Printer to start printing.` | `Move to Favor Printer...` | Yes |
| **3** | Not yet enrolled (`!inputs.enrolled`) | **Amber** | `Not set up yet` | `Enter the six-digit code from an admin.` | `Set up Favor Printer...` | Yes |
| **4** | Supervisor restarting relay (`inputs.relayRestarting`) | **Amber** | `Print relay is restarting` | `Printing resumes in a moment.` | *Dynamic setup / status* | Yes |
| **5** | No Zebra detected on USB (`!inputs.printerAttached`) | **Amber** | `No printer found` | `Plug in the Zebra with its USB cable.` | *Dynamic setup / status* | Yes |
| **6** | CUPS queue missing (`inputs.queue === "missing"`) | **Amber** | `Printer needs setting up` | `Choose Set up printer to continue.` | *Dynamic setup / status* | Yes |
| **7** | CUPS queue disabled in macOS (`inputs.queue === "disabled"`) | **Amber** | `Printer is turned off` | `Turn it back on in System Settings, under Printers & Scanners.` | *Dynamic setup / status* | Yes |
| **8** | Relay starting or stopped (`!relay \|\| relay.state === "starting" \|\| "stopped" \|\| "stopping"`) | **Amber** | `Starting up` | *None* | *Dynamic setup / status* | Yes |
| **9** | RSVP cloud unreachable (`relay.cloud === "unreachable"`) | **Amber** | `Cannot reach Favor RSVP` | `Printing resumes when the internet is back.` | *Dynamic setup / status* | Yes |
| **10** | Printing paused (`inputs.paused \|\| relay.state === "paused"`) | **Amber** | `Printing is paused` | `Choose Resume printing in the menu.` | `Resume printing` | Yes |
| **11** | Background updater downloading (`inputs.update.kind === "downloading"`) | **Amber** | `Updating Favor Printer` | *None* | *Dynamic setup / status* | Yes |
| **12** | Last print job unconfirmed (`relay.lastError === "send_ambiguous"`) | **Green** | `Ready to print` | `The last label may not have printed. Check the label stock.` | `Pause printing` / `Test print...` | Yes |
| **13** | Last print job failed (`relay.lastError === "send_failed"`) | **Green** | `Ready to print` | `The last label failed to print.` | `Pause printing` / `Test print...` | Yes |
| **14** | App update downloaded and staged (`inputs.update.kind === "ready"`) | **Green** | `Ready to print` | `An update installs when you quit.` | `Pause printing` / `Test print...` | Yes |
| **15** | Normal healthy operating state (All checks pass) | **Green** | `Ready to print` | *None* | `Pause printing` / `Test print...` | Yes |

---

## 3. Menu Template Structure

The menu is generated via `buildMenuTemplate(snapshot, actions)`. It contains no volunteer names, label payloads, or sensitive codes.

```text
+-------------------------------------------------------------------+
| [Headline] (e.g. Ready to print / The old print relay is running) |  <- Disabled (Info)
| [Detail]   (e.g. Move to Favor Printer to start printing.)        |  <- Disabled (Info, omitted if null)
| This laptop: [Label] (e.g. Front desk laptop)                     |  <- Disabled (Info, omitted if null)
|-------------------------------------------------------------------|  <- Separator
| Labels this session: {sent} sent, {failed} failed[, {x} to check] |  <- Disabled (Session telemetry)
|-------------------------------------------------------------------|  <- Separator
| [Action based on status: e.g. "Move to Favor Printer..." /        |
|  "Enter a new code..." / "Set up Favor Printer..."]               |  <- Only present when needed
| Pause printing / Resume printing                                  |  <- Enabled only if canPrint
| Test print...                                                     |  <- Enabled only if canPrint
| Keep printing                                                   > |  <- Submenu of hardware warnings
|-------------------------------------------------------------------|  <- Separator
| [x] Open at login                                                 |  <- Checkbox
| Check for updates / Downloading... / Update {v} ready             |  <- Contextual update item
| Update channel                                                  > |  <- Submenu: (•) Stable  ( ) Preview
|-------------------------------------------------------------------|  <- Separator
| Favor Printer {version}                                           |  <- Disabled (Info)
| Quit Favor Printer                                                |  <- Clean quit
+-------------------------------------------------------------------+
```

### Can-Print Permission Gate
The controls `Pause printing`, `Resume printing`, and `Test print...` are enabled **only** when `canPrint` is true:
```typescript
const canPrint = snapshot.enrolled && !revoked && !snapshot.legacyRelayLoaded;
```
If the laptop was revoked, the legacy relay is still loaded, or the laptop has not been enrolled, print commands are rendered inert/disabled so volunteers cannot trigger impossible jobs.

---

## 4. Session Job Counts Formatting

The job count line tracks throughput from the current relay process session only:
```typescript
export function jobCountsLabel(jobs: AppSnapshot["recentJobs"]): string {
  const parts = [`${jobs.sent} sent`, `${jobs.failed} failed`];
  if (jobs.ambiguous > 0) parts.push(`${jobs.ambiguous} to check`);
  return `Labels this session: ${parts.join(", ")}`;
}
```
- When `ambiguous === 0`: `Labels this session: 142 sent, 0 failed`
- When `ambiguous > 0`: `Labels this session: 142 sent, 0 failed, 1 to check`

---

## 5. Update State Mapping in Menu

| `snapshot.update.kind` | Rendered Menu Item | Interactive? | Callback |
|---|---|:---:|---|
| `idle` | `Check for updates` | Yes | `actions.checkForUpdates` |
| `checking` | `Checking for updates...` | No (Info) | *None* |
| `downloading` | `Downloading an update...` | No (Info) | *None* |
| `ready` (with version) | `Update {version} ready. It installs when you quit.` | No (Info) | *None* |
| `ready` (version unset) | `An update is ready. It installs when you quit.` | No (Info) | *None* |
| `error` | `Update check failed. Try again` | Yes | `actions.checkForUpdates` |

---

## 6. Icon and Tooltip Specification

1. **Tray Tooltip:** Always set to `Favor Printer: ${snapshot.status.headline}`. When hovering over the macOS menu bar icon, macOS VoiceOver and pointer users receive immediate operational feedback without opening the menu.
2. **Icon Rendering:**
   - **Green (`positive`):** Steady check / ready printer mark. Indicates zero blockers.
   - **Amber (`warning`):** Attention mark. Indicates setup in progress, pause active, or connectivity degraded.
   - **Red (`error`):** Revoked / alert mark. Indicates laptop token invalidation.
   - All tray icons are provided as template images on macOS so they respect Dark Mode and light menu bar appearances automatically.
