---
version: alpha
name: Favor Printer Design System
description: Visual design tokens, typography, spacing, component semantics and layout grammar for Favor Printer 2026 under design-like-favor.
colors:
  primary: "#121411"
  background: "#fef1e8"
  surface: "#ffffff"
  muted: "#625f59"
  rule: "#ded8d1"
  accent: "#f45500"
  accent-dark: "#c23f00"
  secondary: "#007fae"
  secondary-dark: "#00647f"
  focus: "#005eb8"
  positive: "#34735a"
  warning: "#a65b00"
  soft-accent: "#ffe2d2"
  soft-secondary: "#d8f1f5"
  error: "#c62828"
  error-bg: "#fdecec"
  dark-background: "#1a1714"
  dark-surface: "#272421"
  dark-primary: "#f5f2ed"
  dark-muted: "#a8a49d"
  dark-rule: "#423d38"
  dark-accent: "#c23f00"
  dark-accent-highlight: "#f45500"
  dark-accent-soft: "#4a2717"
  dark-secondary: "#3cb0db"
  dark-secondary-soft: "#193845"
  dark-focus: "#4da3ff"
  dark-positive: "#4cc77e"
  dark-warning: "#f0a73a"
  dark-error: "#ff6b6b"
  dark-error-bg: "#3a2020"
typography:
  display-hero:
    fontFamily: '"Favorvetica", Arial, sans-serif'
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.01em
  title-section:
    fontFamily: '"Favor Sans", Arial, sans-serif'
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.3
  body-md:
    fontFamily: '"Favor Sans", Arial, sans-serif'
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.45
  body-lead:
    fontFamily: '"Favor Sans", Arial, sans-serif'
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.45
  caption-sm:
    fontFamily: '"Favor Sans", Arial, sans-serif'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
  eyebrow-step:
    fontFamily: '"Favor Sans", Arial, sans-serif'
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.08em
  code-display:
    fontFamily: '"Favor Sans", Arial, sans-serif'
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.35em
rounded:
  sm: 4px
  md: 8px
  lg: 10px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 40px
components:
  button-primary:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 10px 18px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 10px 18px
  status-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.caption-sm}"
    rounded: "{rounded.full}"
    padding: 8px 14px
  status-dot-green:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.positive}"
    rounded: "{rounded.full}"
    size: 10px
  status-dot-amber:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
    rounded: "{rounded.full}"
    size: 10px
  status-dot-red:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
    rounded: "{rounded.full}"
    size: 10px
  code-box:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.code-display}"
    rounded: "{rounded.lg}"
    padding: 14px 12px
  note-error:
    backgroundColor: "{colors.error-bg}"
    textColor: "{colors.error}"
    typography: "{typography.caption-sm}"
    rounded: "{rounded.lg}"
    padding: 12px 14px
  note-info:
    backgroundColor: "{colors.soft-secondary}"
    textColor: "{colors.secondary-dark}"
    typography: "{typography.caption-sm}"
    rounded: "{rounded.lg}"
    padding: 12px 14px
  focus-ring:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.focus}"
    rounded: "{rounded.lg}"
    padding: 2px
  decorative-mark:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.primary}"
    rounded: "{rounded.full}"
    size: 24px
  brand-badge:
    backgroundColor: "{colors.soft-accent}"
    textColor: "{colors.primary}"
    typography: "{typography.eyebrow-step}"
    rounded: "{rounded.full}"
    padding: 4px 8px
  card-choice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 14px 16px
  card-choice-selected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 14px 16px
  divider-rule:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.rule}"
    height: 1px
    width: 100%
---

# Favor Printer Design System (2026)

## Overview

Favor Printer is a mission-critical utility for Favor Church Sunday services and events. It bridges Favor RSVP cloud check-in stations with Zebra thermal label printers connected via USB on volunteer-operated MacBooks.

The operating context is **Operate**:
- **Authorship & Methodology:** The visual direction, design tokens, copy deck, tray spec, and interactive mockups in `docs/design/` were authored by a Gemini design agent (`agy/gemini-3.8-flash@medium`) executing the `design-like-favor` skill (Favor Church brand and desktop app design system) and copy guidelines in `speak-like-favor`.
- **Audience:** Sunday service volunteers and venue leads setting up check-in desks before church starts.
- **Tone:** Warm, calm, dependable, authentic, and unambiguous. We avoid sterile enterprise SaaS grays while rejecting unnecessary visual clutter that distracts from operational readiness.
- **Foundational Rule & Provenance:** Every color, type role, spacing, and structural element is directly mapped to canonical sources in the `design-like-favor` direction (canonical Favor 2026 tokens in `brand-2026.json` and `favor-design-dna.md`). Note on skill scope: `design-like-favor` governs general Favor app styling, desktop interfaces, and component grammar, distinct from web analytics dashboards in `dashboards-like-favor`. Canonical tokens (`brand-2026.json` and `favor-design-dna.md`) are applied here strictly under the `design-like-favor` desktop application framework.

### Brand Silence and No-Invented-Values Policy

Where the design skill is silent on specific desktop-application concerns, this specification explicitly declares the fallback rather than fabricating brand values:
- **Shadows:** The Favor 2026 design DNA expressly favors 1px clean rules (`#ded8d1`) and high-contrast ink boundaries over drop shadows. Heavy elevation drop shadows are **not part of the design system**. Modest elevation (`0 1px 3px rgba(18, 20, 17, 0.08)`) is used only for raised cards if necessary; otherwise surfaces remain clean flat planes separated by borders.
- **Motion & Transitions:** The brand skill declares no proprietary easing curves or animation tokens. We deliberately specify native macOS-standard micro-transitions (`opacity 150ms ease`, `border-color 150ms ease`, `transform 150ms cubic-bezier(0.16, 1, 0.3, 1)`) for interactive hover/focus states, and disable motion when `prefers-reduced-motion: reduce` is detected.
- **Dark Mode Palette Fallback:** The canonical brand token snapshot in `brand-2026.json` is light-only (`#fef1e8` cream ground, `#ffffff` card surface, `#121411` ink) and does not specify a proprietary dark brand palette. To support macOS system dark mode without inventing non-existent "brand" dark colors, we explicitly declare an accessible, non-brand fallback palette that preserves semantic hierarchy and satisfies WCAG AA contrast requirements:
  - Canvas background: `#1a1714` (warm dark ground)
  - Card/surface: `#272421` (elevated dark surface)
  - Primary text / ink: `#f5f2ed` (15.9:1 on canvas, 13.8:1 on surface)
  - Muted text: `#a8a49d` (7.2:1 on canvas, 6.2:1 on surface)
  - Border rules: `#423d38`
  - Primary interactive button: Ground `#c23f00` (`accent-dark`) with `#ffffff` text (`--accent-text`), delivering **5.28:1** contrast (passes WCAG AA 4.5:1). Undarkened brand orange `#f45500` with white text yields 3.4:1 and MUST NOT be used for primary button ground in dark mode.
  - Secondary action: `#3cb0db` (7.2:1 contrast against `#1a1714`)
  - Secondary tint ground: `#193845`
  - Focus outline: `#4da3ff`
  - Status indicators: Green `#4cc77e`, Amber `#f0a73a`, Red `#ff6b6b`, Red tint `#3a2020`

---

## Colors

All canonical light color values derive from `brand-2026.json` and `favor-design-dna.md`. Dark mode tokens are explicitly specified as non-brand accessibility fallbacks:

### Canonical Light Palette
| Token | Hex Value | Role & Usage | Source Reference |
|---|---|---|---|
| `primary` (`ink`) | `#121411` | Primary text, headings, strong borders | `brand-2026.json` (`tokens.ink`) |
| `background` (`cream`) | `#fef1e8` | Application ground and screen canvas | `brand-2026.json` (`tokens.background`) |
| `surface` (`white`) | `#ffffff` | Setup cards, input boxes, selectable choices | `brand-2026.json` (`tokens.surface`) |
| `muted` (`mutedInk`) | `#625f59` | Secondary captions, helper hints, step labels | `brand-2026.json` (`tokens.mutedInk`) |
| `rule` | `#ded8d1` | Borders, choice separators, horizontal dividers | `brand-2026.json` (`tokens.rule`) |
| `accent` | `#f45500` | Canonical brand orange (accents, marks, badges) | `brand-2026.json` (`tokens.accent`) |
| `accent-dark` | `#c23f00` | Accessible interactive text & solid button fills | `favor-design-dna.md` Section 1 |
| `secondary` | `#007fae` | Secondary actions, link highlights | `brand-2026.json` (`tokens.secondary`) |
| `secondary-dark` | `#00647f` | Accessible action text on light surfaces | `favor-design-dna.md` Section 1 |
| `focus` | `#005eb8` | Focus ring outline for keyboard accessibility | `brand-2026.json` (`tokens.focus`) |
| `positive` | `#34735a` | Ready status indicator dot, success marks | `brand-2026.json` (`tokens.positive`) |
| `warning` | `#a65b00` | Attention needed, amber status dot | `brand-2026.json` (`tokens.warning`) |
| `error` | `#c62828` | Error alert text, red status dot, invalid borders | Project app baseline / accessible red |
| `error-bg` | `#fdecec` | Error alert card background | Project app baseline / soft tint |
| `soft-accent` | `#ffe2d2` | Soft orange card ground, badge fill | `brand-2026.json` (`tokens.softAccent`) |
| `soft-secondary` | `#d8f1f5` | Info banner ground, secondary badge fill | `brand-2026.json` (`tokens.softSecondary`) |

### Non-Brand Dark Mode Fallback Palette
| Token | Hex Value | Role & Usage | Contrast vs Background/Surface |
|---|---|---|---|
| `dark-background` | `#1a1714` | macOS Dark canvas ground | N/A |
| `dark-surface` | `#272421` | Dark card, modal, and input surface | N/A |
| `dark-primary` | `#f5f2ed` | High-contrast body text and titles | 15.9:1 on bg, 13.8:1 on surface |
| `dark-muted` | `#a8a49d` | Secondary hints, captions, step labels | 7.2:1 on bg, 6.2:1 on surface |
| `dark-rule` | `#423d38` | Dark mode dividers and card borders | N/A |
| `dark-accent` | `#c23f00` | Primary button ground (`accent-dark`) | 5.28:1 with `#ffffff` text (passes WCAG AA) |
| `dark-accent-highlight` | `#f45500` | Non-text decorative accents & marks | 5.2:1 on bg, 4.5:1 on surface |
| `dark-accent-soft` | `#4a2717` | Dark mode tinted selection ground | N/A |
| `dark-secondary` | `#3cb0db` | Secondary text links and interactive cues | 7.2:1 on bg |
| `dark-secondary-soft` | `#193845` | Dark mode info banner background | N/A |
| `dark-focus` | `#4da3ff` | Dark mode focus ring outline | High visibility on dark ground |
| `dark-positive` | `#4cc77e` | Dark mode ready status indicator dot | High visibility on dark surface |
| `dark-warning` | `#f0a73a` | Dark mode warning status indicator dot | High visibility on dark surface |
| `dark-error` | `#ff6b6b` | Dark mode error status dot & alert text | High visibility on dark surface |
| `dark-error-bg` | `#3a2020` | Dark mode error note card background | N/A |

### Contrast and Accessibility Rules
- The undarkened brand orange `#f45500` fails WCAG AA 4.5:1 on pure white (`#ffffff`) and when paired with white text (3.4:1). Per `favor-design-dna.md` Section 1 ("Contrast adaptation"), interactive primary button backgrounds and text elements use `accent-dark` (`#c23f00`), which delivers **4.78:1** contrast on white in light mode, and **5.28:1** with `#ffffff` text in dark mode (matching `--accent-text: #ffffff` in CSS).
- Secondary interactive elements use `secondary-dark` (`#00647f`) in light mode (delivering **5.38:1** on white), and `#3cb0db` in dark mode (delivering **7.16:1** on dark background).
- Status indications NEVER rely solely on color. Every pill, state card, and tray item combines an icon/shape indicator with explicit plain text words (`Ready`, `Attention needed`, `Removed`).

---

## Typography

Typography assignments follow the source typography roles in `dashboards-like-favor/references/favor-design-dna.md` Section 2:

| Role Name | Token | Font Stack | Specs (Size / Weight / Line Height) | Usage |
|---|---|---|---|---|
| Display Hero | `display-hero` | `"Favorvetica", Arial, sans-serif` | 26px / 700 / 1.2 / -0.01em | Screen `h1` titles |
| Section Title | `title-section` | `"Favor Sans", Arial, sans-serif` | 18px / 700 / 1.3 / normal | Subheadings, card titles |
| Body Lead | `body-lead` | `"Favor Sans", Arial, sans-serif` | 16px / 400 / 1.45 / normal | Lead descriptive paragraphs |
| Body Standard | `body-md` | `"Favor Sans", Arial, sans-serif` | 15px / 400 / 1.45 / normal | General UI copy, list items, buttons |
| Caption / Hint | `caption-sm` | `"Favor Sans", Arial, sans-serif` | 13px / 400 / 1.4 / normal | Helper text, secondary device detail |
| Eyebrow / Step | `eyebrow-step` | `"Favor Sans", Arial, sans-serif` | 12px / 700 / 1.0 / 0.08em uppercase | "STEP 1 OF 5" progress indicators |
| Code Numeric | `code-display` | `"Favor Sans", Arial, sans-serif` | 32px / 700 / 1.0 / 0.35em tabular-nums | 6-digit one-time enrollment box |

### Restraint & Font Fallbacks
In compliance with `favor-design-dna.md` Section 2, proprietary font binaries are not bundled in repository source. The CSS font stack specifies `"Favor Sans"` and `"Favorvetica"` with clean system and Arial fallbacks (`-apple-system, BlinkMacSystemFont, "SF Pro Text", Arial, sans-serif`). Expressive novelty fonts (such as Favor Folk or Cutout) are strictly excluded from this operational utility.

---

## Layout

- **Window Sizing:** The setup window runs at a fixed 520px canvas width and 640px height inside Electron.
- **Vertical Rhythm:** A flex column container with `padding: 40px 36px 32px` and `gap: 18px`.
- **Action Rail:** Primary and secondary action buttons sit in a bottom action bar with `margin-top: auto` and a generous touch-friendly layout.
- **Spacing Scale:** Standard 8px geometric scale (`xs: 4px`, `sm: 8px`, `md: 16px`, `lg: 24px`, `xl: 32px`, `xxl: 40px`).
- **Interactive Targets:** Primary interactive controls maintain at least 44px minimum vertical tap/click targets.

---

## Elevation & Depth

In alignment with `favor-design-dna.md` Section 5:
- Visual hierarchy is established through tonal grounding (warm `#fef1e8` cream background vs. crisp `#ffffff` cards and inputs) and 1px borders (`#ded8d1`).
- Heavy drop shadows are omitted. When subtle elevation is needed for floating preview panels, a single subtle layer is used: `box-shadow: 0 1px 3px rgba(18, 20, 17, 0.08)`.

---

## Shapes

- **Inputs, Buttons, and Cards:** `10px` border radius (`rounded.lg`), providing modern softness consistent with macOS HIG and Favor UI.
- **Pills and Badges:** Full pill radius `9999px` (`rounded.full`).
- **Corner Micro-Accents:** `4px` (`rounded.sm`) on small chips or error bars.

---

## Components

### 1. Primary Button (`button-primary`)
- Ground: `accent-dark` (`#c23f00`)
- Text: White (`#ffffff`), font weight 600
- Padding: `10px 18px` (min-height 44px)
- Focus State: Outline 3px `focus` (`#005eb8`) with 2px offset.

### 2. Secondary Button (`button-secondary`)
- Ground: `surface` (`#ffffff`)
- Border: 1px `rule` (`#ded8d1`)
- Text: `primary` (`#121411`), font weight 600
- Padding: `10px 18px` (min-height 44px)

### 3. Status Pill (`status-pill`)
- Ground: `surface` (`#ffffff`) with 1px border `#ded8d1`
- Indicator: 10px circular color dot (`#34735a` positive green, `#a65b00` warning amber, `#c62828` error red)
- Label: Plain language status text (e.g., "Ready to print", "The old print relay is still running", "This laptop was removed").

### 4. Code Entry Box (`code-box`)
- Ground: `surface` (`#ffffff`)
- Typography: 32px tabular figures, letter-spacing `0.35em`, centered alignment.
- Validation Border: `rule` (`#ded8d1`) when clean, `error` (`#c62828`) when invalid.

### 5. Choice List & Radio Cards
- Individual device card on `#ffffff` with 1px `#ded8d1` border.
- Selected state: border highlighted with `accent-dark` (`#c23f00`) and soft tint ground.

---

## Do's and Don'ts

### Do:
- **Do** use warm `#fef1e8` cream canvas ground and `#ffffff` surfaces.
- **Do** use darkened orange `#c23f00` for text and primary button backgrounds to ensure accessible contrast.
- **Do** accompany every color status dot with clear descriptive words.
- **Do** preserve 44px touch targets on all interactive actions.
- **Do** speak like a helpful peer using Favor voice: warm, concise, and direct.

### Don't:
- **Don't** paint generic SaaS slate/gray-on-gray chrome and call it Favor.
- **Don't** flood entire screens in orange background. Orange is a deliberate accent.
- **Don't** use decorative display fonts (Favor Cutout, Folk, Shines Paws) on an operational tool.
- **Don't** use em dashes in any copy (use commas, colons, or periods per `speak-like-favor`).
- **Don't** invent brand values, random font stacks, or exaggerated drop shadows where the design guidelines are silent.
