import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { CommandResult, CommandRunner } from "../services/command";
import {
  createDeferredOpen,
  detectLoginLaunch,
  loginItemSettings,
  readWindowsStartupApproval,
  shouldShowWindowAtLaunch,
  WINDOWS_LOGIN_ARG,
  WINDOWS_LOGIN_ITEM_NAME,
  type LaunchWindowInput,
} from "./launch";

describe("shouldShowWindowAtLaunch", () => {
  it.each<[string, LaunchWindowInput, boolean]>([
    [
      "user launch with complete setup shows window",
      { wasOpenedAtLogin: false, setupStep: null, legacyRelayLoaded: false, revoked: false },
      true,
    ],
    [
      "user launch while revoked shows window",
      { wasOpenedAtLogin: false, setupStep: null, legacyRelayLoaded: false, revoked: true },
      true,
    ],
    [
      "user launch with incomplete setup shows window",
      { wasOpenedAtLogin: false, setupStep: "welcome", legacyRelayLoaded: false, revoked: false },
      true,
    ],
    [
      "login launch with complete setup stays in menu bar",
      { wasOpenedAtLogin: true, setupStep: null, legacyRelayLoaded: false, revoked: false },
      false,
    ],
    [
      "login launch while revoked shows window (printing is off and needs a code)",
      { wasOpenedAtLogin: true, setupStep: null, legacyRelayLoaded: false, revoked: true },
      true,
    ],
    [
      "login launch with incomplete setup shows window",
      { wasOpenedAtLogin: true, setupStep: "welcome", legacyRelayLoaded: false, revoked: false },
      true,
    ],
    [
      "login launch with connected step pending test-print shows window",
      { wasOpenedAtLogin: true, setupStep: "connected", legacyRelayLoaded: false, revoked: false },
      true,
    ],
    [
      "login launch with legacy relay loaded shows window",
      { wasOpenedAtLogin: true, setupStep: null, legacyRelayLoaded: true, revoked: false },
      true,
    ],
    [
      "unavailable detection falls back to showing window even with complete setup",
      { wasOpenedAtLogin: null, setupStep: null, legacyRelayLoaded: false, revoked: false },
      true,
    ],
  ])("%s", (_name, input, expected) => {
    expect(shouldShowWindowAtLaunch(input)).toBe(expected);
  });
});

describe("detectLoginLaunch", () => {
  it("reads wasOpenedAtLogin from getLoginItemSettings", () => {
    expect(detectLoginLaunch({ getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) })).toBe(true);
    expect(detectLoginLaunch({ getLoginItemSettings: () => ({ wasOpenedAtLogin: false }) })).toBe(false);
  });

  it("returns null when getLoginItemSettings is missing, throws, or omits wasOpenedAtLogin", () => {
    expect(detectLoginLaunch({})).toBeNull();
    expect(
      detectLoginLaunch({
        getLoginItemSettings: vi.fn(() => {
          throw new Error("unsupported");
        }),
      }),
    ).toBeNull();
    expect(detectLoginLaunch({ getLoginItemSettings: () => ({}) })).toBeNull();
  });

  it("on Windows reads the login argument from argv, never wasOpenedAtLogin", () => {
    const settings = { getLoginItemSettings: () => ({ wasOpenedAtLogin: undefined }) };
    expect(detectLoginLaunch(settings, "win32", ["Favor Printer.exe", WINDOWS_LOGIN_ARG])).toBe(true);
    expect(detectLoginLaunch(settings, "win32", ["Favor Printer.exe"])).toBe(false);
    expect(detectLoginLaunch({ getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) }, "win32", ["Favor Printer.exe"])).toBe(false);
  });

  it("keeps a paired Windows host in the tray at login and shows the window on a user launch", () => {
    const paired = { setupStep: null, legacyRelayLoaded: false, revoked: false };
    expect(shouldShowWindowAtLaunch({ ...paired, wasOpenedAtLogin: detectLoginLaunch({}, "win32", ["x", WINDOWS_LOGIN_ARG]) })).toBe(false);
    expect(shouldShowWindowAtLaunch({ ...paired, wasOpenedAtLogin: detectLoginLaunch({}, "win32", ["x"]) })).toBe(true);
  });
});

describe("loginItemSettings", () => {
  it("registers the Windows login item with the login argument and leaves macOS unchanged", () => {
    expect(loginItemSettings(true, "win32")).toEqual({ openAtLogin: true, args: [WINDOWS_LOGIN_ARG], name: WINDOWS_LOGIN_ITEM_NAME, enabled: true });
    expect(loginItemSettings(false, "win32")).toMatchObject({ openAtLogin: false, args: [WINDOWS_LOGIN_ARG] });
    expect(loginItemSettings(true, "darwin", false)).toEqual({ openAtLogin: true });
  });

  it("writes the Startup apps state it is given, so a re-register can keep 'off'", () => {
    expect(loginItemSettings(true, "win32", false).enabled).toBe(false);
  });

  it("the uninstaller deletes the same Run value name the app writes", () => {
    const nsis = readFileSync(new URL("../../../../build/installer.nsh", import.meta.url), "utf8");
    expect(nsis).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${WINDOWS_LOGIN_ITEM_NAME}"`);
  });
});

describe("readWindowsStartupApproval", () => {
  // Shapes copied from reg.exe on Windows 11 26200.
  const value = (hex: string) =>
    `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run\r\n    ${WINDOWS_LOGIN_ITEM_NAME}    REG_BINARY    ${hex}\r\n\r\n`;
  /** `key` answers the follow-up query of the whole key (no `/v`). */
  const runner = (result: Partial<CommandResult>, key: Partial<CommandResult> = { code: 0 }) => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run: CommandRunner = async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...(args.includes("/v") ? result : key) };
    };
    return { run, calls };
  };
  const missingValue = { code: 1, stderr: "ERROR: The system was unable to find the specified registry key or value.\r\n" };

  it("reads Task Manager's off (03/07) and on (02/06) for this app's value only", async () => {
    for (const [hex, on] of [["0300000079C7A3AF8678DD01", false], ["070000000000000000000000", false], ["020000000000000000000000", true], ["06000000", true]] as const) {
      const { run, calls } = runner({ stdout: value(hex) });
      expect(await readWindowsStartupApproval(run)).toBe(on);
      expect(calls[0].file).toBe("C:\\Windows\\System32\\reg.exe");
      expect(calls[0].args).toEqual(["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run", "/v", WINDOWS_LOGIN_ITEM_NAME]);
    }
  });

  it("treats no record as on, but only when the key itself reads cleanly", async () => {
    expect(await readWindowsStartupApproval(runner(missingValue).run)).toBe(true);
    // Access denied, a broken or absent key: same exit 1 for the value, but the key query fails too.
    expect(await readWindowsStartupApproval(runner(missingValue, { code: 1 }).run)).toBeNull();
  });

  it("returns null when it cannot tell, so the entry is left alone", async () => {
    for (const result of [{ code: null, stderr: "spawn ENOENT" }, { code: null, timedOut: true }, { code: 0, stdout: "garbage" }, { code: 1, timedOut: true }, { code: 5 }]) {
      expect(await readWindowsStartupApproval(runner(result).run)).toBeNull();
    }
  });
});

describe("createDeferredOpen", () => {
  it("honors a request made before ready exactly once", () => {
    const gate = createDeferredOpen();
    const open = vi.fn();
    gate.request();
    gate.request();
    expect(gate.ready(open)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reports nothing to honor when no request arrived, then opens directly", () => {
    const gate = createDeferredOpen();
    const open = vi.fn();
    expect(gate.ready(open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    gate.request();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
