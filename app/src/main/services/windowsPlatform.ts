/** Fixed app-owned Windows paths and a no-op legacy macOS migration adapter. */
import path from "node:path";
import type { LegacyRelay } from "./legacyRelay";

export const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Never take a script or executable location from a printer, QR code or cloud response. */
export function windowsResourcePaths(input: { packaged: boolean; resourcesDir: string; projectDir: string }) {
  const root = input.packaged ? path.win32.join(input.resourcesDir, "windows") : path.win32.join(input.projectDir, "scripts", "windows");
  return {
    powershellPath: WINDOWS_POWERSHELL,
    probePath: path.win32.join(root, "probe-printers.ps1"),
    printPath: path.win32.join(root, "print-raw.ps1"),
  };
}

/** A Windows host cannot run, detect, or migrate a macOS launchd agent. */
export function noLegacyMacAgent(): LegacyRelay {
  return {
    detect: async () => ({ plistPresent: false, loaded: false }),
    migrate: async () => ({ ok: true }),
    canStartRelay: async () => ({ allowed: true }),
  };
}
