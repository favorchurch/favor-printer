/**
 * Launch-time window visibility: decides whether to open the setup/status window
 * on startup, and detects whether macOS launched the app as a login item.
 */

import type { SetupStep } from "../../shared";

export type LoginItemSettingsApp = {
  getLoginItemSettings?: () => { wasOpenedAtLogin?: unknown };
};

export type LaunchWindowInput = {
  /** Null when login-launch detection is unavailable (falls back to showing the window). */
  wasOpenedAtLogin: boolean | null;
  setupStep: SetupStep | null;
  legacyRelayLoaded: boolean;
  revoked: boolean;
};

/**
 * Uses Electron's `app.getLoginItemSettings().wasOpenedAtLogin` (supported in
 * Electron 44 on macOS). Returns `null` when detection is unavailable.
 */
export function detectLoginLaunch(app: LoginItemSettingsApp): boolean | null {
  if (typeof app.getLoginItemSettings !== "function") return null;
  try {
    const settings = app.getLoginItemSettings();
    if (!settings || typeof settings.wasOpenedAtLogin !== "boolean") return null;
    return settings.wasOpenedAtLogin;
  } catch {
    return null;
  }
}

/**
 * Returns true when the setup/status window should open at launch.
 *
 * A user-initiated launch (or unavailable detection) always shows the window.
 * A login-item launch stays in the menu bar only when setup is complete,
 * the laptop is not revoked, and no legacy relay needs migration.
 */
export function shouldShowWindowAtLaunch(input: LaunchWindowInput): boolean {
  if (input.wasOpenedAtLogin !== true) return true;
  return input.setupStep !== null || input.legacyRelayLoaded || input.revoked;
}
