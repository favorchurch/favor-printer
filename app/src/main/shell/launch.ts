/**
 * Launch-time window visibility: decides whether to open the setup/status window
 * on startup, and detects whether macOS launched the app as a login item.
 */

import { PRODUCT_NAME, type SetupStep } from "../../shared";
import type { CommandRunner } from "../services/command";

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
 * Windows has no `wasOpenedAtLogin`, so the login item is registered with this
 * argument (`loginItemSettings`) and a login launch is read from `argv`.
 */
export const WINDOWS_LOGIN_ARG = "--login-launch";

/** The HKCU Run value name. `build/installer.nsh` deletes this exact name on uninstall. */
export const WINDOWS_LOGIN_ITEM_NAME = `electron.app.${PRODUCT_NAME}`;

export type LoginItemSettings = { openAtLogin: boolean; args?: string[]; name?: string; enabled?: boolean };

/**
 * What `app.setLoginItemSettings` takes on this platform. On Windows `approved` is the Startup apps on/off state
 * to write: a launch-time re-register passes what Task Manager or Settings currently has
 * (`readWindowsStartupApproval`), so the volunteer's or IT's choice stands; an in-app toggle leaves it out and approves.
 */
export function loginItemSettings(openAtLogin: boolean, platform: NodeJS.Platform, approved = true): LoginItemSettings {
  if (platform !== "win32") return { openAtLogin };
  return { openAtLogin, args: [WINDOWS_LOGIN_ARG], name: WINDOWS_LOGIN_ITEM_NAME, enabled: approved };
}

const REG_EXE = "C:\\Windows\\System32\\reg.exe";
const STARTUP_APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

/**
 * Reads whether Windows' Startup apps list has this app on. Electron's own `getLoginItemSettings().launchItems`
 * is empty when the exe path has spaces (`...\Favor Printer\Favor Printer.exe`), so this asks `reg.exe` directly.
 * No value means Windows has no record yet, which is "on". Returns null when it cannot tell, so the caller can
 * leave the entry alone instead of guessing.
 */
export async function readWindowsStartupApproval(run: CommandRunner): Promise<boolean | null> {
  const result = await run(REG_EXE, ["query", STARTUP_APPROVED_KEY, "/v", WINDOWS_LOGIN_ITEM_NAME], { timeoutMs: 5_000 });
  // reg.exe exits 1 both for a missing value and other failures, so the stdout shape decides.
  if (result.code !== 0) return result.code === 1 && !result.timedOut && result.stdout.trim() === "" ? true : null;
  const match = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(result.stdout);
  if (!match) return null;
  // Windows writes 02 (or 06) for on and 03 (or 07) for off: the low bit means disabled.
  return (Number.parseInt(match[1], 16) & 1) === 0;
}

/**
 * Uses Electron's `app.getLoginItemSettings().wasOpenedAtLogin` (supported in
 * Electron 44 on macOS) and `WINDOWS_LOGIN_ARG` on Windows. Returns `null`
 * when detection is unavailable.
 */
export function detectLoginLaunch(app: LoginItemSettingsApp, platform: NodeJS.Platform = "darwin", argv: readonly string[] = []): boolean | null {
  if (platform === "win32") return argv.includes(WINDOWS_LOGIN_ARG);
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

/**
 * Holds "open the window" requests (e.g. a second-instance launch) that arrive
 * before startup has finished, so none is lost and startup does not suppress it.
 */
export function createDeferredOpen() {
  let pending = false;
  let open: (() => void) | null = null;
  return {
    request(): void {
      if (open) open();
      else pending = true;
    },
    /** Installs the handler and honors a pending request once. Returns true if it opened. */
    ready(handler: () => void): boolean {
      open = handler;
      if (!pending) return false;
      pending = false;
      handler();
      return true;
    },
  };
}
