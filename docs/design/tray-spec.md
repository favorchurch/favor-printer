# Favor Printer macOS Menu Bar Tray Specification

This document specifies the behavior, menu hierarchy, icon visual indicators, and complete state mapping for the Favor Printer macOS menu bar tray.

---

## 1. Architecture and State Mapping

The tray view is driven purely by the system state snapshot evaluated through `deriveStatus(inputs: StatusInputs)` in `app/src/main/services/statusSummary.ts`. Its headline always uses the five operating states from the shared reducer; the operational summary supplies the supporting detail and icon color.

The core operating principle: **Red outranks amber; amber outranks green. Green requires every single operational check to pass.**

Status values map directly to:
1. **Tray Menu Icon:** Dedicated template icons for Green (Ready), Amber (Attention Needed), and Red (Revoked / Removed).
2. **Tray Tooltip:** `Favor Printer: {headline}`.
3. **Menu Header:** Headline followed by contextual detail line (if present), laptop identifier label, and session counts.
4. **Contextual Action:** Dynamic setup, re-enrollment, or migration action.
5. **Print Controls:** Paused vs. Resume state.
6. **Background Preferences:** Open at login, updates, and channels.

---

## 2. Five-State Headline Table

The same headline appears in the status pill, tray menu, and tray tooltip. `lastSeenAt` records the most recent successful scan that found the printer. Presence starts unknown; after two consecutive failed listings it becomes unknown again, and the headline is Waiting for connection. Failed listings never invent an unplug event or a ready state.

| Five-state reducer value | Headline |
|---|---|
| `Connected` | `Connected` |
| `Unplugged` | `Printer unplugged` |
| `Waiting` | `Waiting for connection` |
| `Needs re-enrollment` | `Needs re-enrollment` |
| `In use elsewhere` | `Printer in use elsewhere` |

The contextual detail continues to explain operational causes such as setup, cloud availability, pause state, or the legacy relay. The menu actions and print permission gate remain as specified below.

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

### 1. Tray Tooltip
Always set to `Favor Printer: ${snapshot.status.headline}`, using the five-state headline above. When hovering over the macOS menu bar icon, macOS VoiceOver and pointer users receive immediate operational feedback without opening the menu.

### 2. Template Image Constraints & Rendering
- **macOS Template Image Rules:** Tray icons are rendered purely in code as macOS template PNG images: RGB is 0 (pure black `#000000`) everywhere, and opacity is controlled strictly via the alpha channel (`pixels[(row * size + column) * 4 + 3]`). This enables macOS to automatically tint the icon for light menu bars, dark menu bars, system accent selections, and wallpaper backgrounds.
- **Color Independence:** Because template images cannot carry color in the menu bar, the operational state is communicated entirely through **distinct geometric shapes**:
  - Green (Ready) MUST be recognizably different from Amber (Attention) and Red (Revoked) by contour alone.
- **Sizing & Resolution:**
  - Base point size: 18 points (`ICON_POINTS = 18`).
  - Standard scale (1x): 18x18 px.
  - Retina scale (2x): 36x36 px (`ICON_POINTS * 2`).
  - Antialiasing: 4x4 sub-pixel sampling (`SAMPLES = 4`) for clean edges at Retina resolutions.
  - Padding & Safe Bounds: Corner pixels must be fully transparent (`alpha === 0`). The glyphs must fit within a normalized bounding radius of $r \le 0.47$ (leaving at least 1px safe boundary padding from the 18pt edge).

### 3. Concrete Icon Geometry Specifications
Each state corresponds to an exact mathematical geometry evaluated over normalized coordinates $(x, y) \in [0, 1] \times [0, 1]$ centered at $(0.5, 0.5)$ with radial distance $r = \sqrt{(x - 0.5)^2 + (y - 0.5)^2}$:

1. **Green (`positive` / Ready): Open Ring with Check Mark**
   - **Visual Role:** Confirms all systems are normal and ready to print.
   - **Outer Ring:** Annular ring between radius $0.37 \le r \le 0.47$ (stroke width $\approx 0.10$, approx 3.6px at 2x).
   - **Check Glyph:** Connected two-segment check mark centered within the glyph:
     - Down-stroke segment: From $(0.29, 0.52)$ to $(0.44, 0.67)$ with stroke thickness radius $0.05$.
     - Up-stroke segment: From $(0.44, 0.67)$ to $(0.72, 0.35)$ with stroke thickness radius $0.05$.
   - **Template Contrast:** The open ring allows menu bar background to show through, while the interior check provides unambiguous affirmative confirmation.

2. **Amber (`warning` / Attention Needed): Open Ring with Exclamation Point**
   - **Visual Role:** Alerts the volunteer that setup is incomplete, printing is paused, or connection is degraded.
   - **Outer Ring:** Annular ring between radius $0.37 \le r \le 0.47$ (identical perimeter weight to green for visual rhythm).
   - **Exclamation Bar:** Centered vertical stroke:
     - Horizontal bounds: $0.45 \le x \le 0.55$ (width $0.10$).
     - Vertical bounds: $0.25 \le y \le 0.56$ (height $0.31$).
   - **Exclamation Dot:** Centered circular dot at $(0.5, 0.69)$ with radius $0.065$ (leaving a $0.065$ vertical aperture gap between bar and dot).
   - **Symmetry:** Strictly symmetric across the vertical axis $x = 0.5$.

3. **Red (`error` / Revoked / Removed): Solid Disc with Inverted Cut-Out Cross**
   - **Visual Role:** Immediately warns of revocation or credential rejection. Outranks all other states.
   - **Disc Base:** Solid circular disc filling radius $r \le 0.47$.
   - **Negative Cross Cut-Out:** Two intersecting diagonal cutout strokes forming an "X", where the disc pixels are subtracted:
     - Diagonal 1: From $(0.33, 0.33)$ to $(0.67, 0.67)$ with cutout radius $0.055$.
     - Diagonal 2: From $(0.67, 0.33)$ to $(0.33, 0.67)$ with cutout radius $0.055$.
   - **Contrast with Rings:** While Green and Amber use open ring geometry ($r < 0.37$ is hollow background), Red is a solid filled silhouette disc with negative cutout space ($r < 0.37$ outside the X has alpha $> 200$), providing instant silhouette distinction even in peripheral vision.

### 4. Design Decision: Retention of Current Template Glyphs & Copy (Recorded No-Change)
The existing template glyph implementations (`app/src/main/shell/trayIcons.ts`) were reviewed against the Favor 2026 design system and accessibility requirements.

Because:
1. The mathematical template contours (ring with check mark, ring with exclamation mark, solid disc with inverted knockout cross) provide unambiguous, color-blind accessible silhouette contrast across both macOS light and dark menu bars without relying on color tinting, and
2. The five-state headlines and operational detail lines established in `statusSummary.ts` and `tray.ts` use the approved concise status language,

**the current template glyphs are retained by design**. Their geometry is pinned and verified by unit tests in `app/src/main/shell/trayIcons.test.ts`; headline conformance is covered in `app/src/main/services/statusSummary.test.ts` and `app/src/main/shell/tray.test.ts`.
