# Mac Favor Design System — compact window and accessibility check (#7)

Main already contains Favor 2026 layout tokens, Favorvetica/Favor Sans roles, explicit test-label confirmation, legacy conflict warning, enrollment error help, reduced-motion support and the menu bar outline icons. This change **does not recreate** those shipped features.

## Incremental checks

- At 520×640, 520×480 and 420×440, the first focusable setup step stays visible and the card can scroll vertically rather than being clipped by centered fixed-height layout.
- With macOS Increase Contrast, controls gain a distinct 2px rule and 4px focus outline; keyboard-only users can find the current action.
- In forced-colors mode, selected choices and pills have a distinguishable non-color-only outline/status silhouette.
- In reduced-motion mode, transitions stay disabled as before.
- In light and dark mode, existing semantic colors, orange accessible primary action, and Favor type roles remain unchanged.

The Linux renderer/unit checks validate source and logic; this is **not a Mac screenshot approval**. Verify in the actual signed/notarized Mac app across accessibility settings before closing #7.
