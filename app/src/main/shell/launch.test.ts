import { describe, expect, it, vi } from "vitest";

import { createDeferredOpen, detectLoginLaunch, loginItemSettings, shouldShowWindowAtLaunch, WINDOWS_LOGIN_ARG, type LaunchWindowInput } from "./launch";

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
    expect(loginItemSettings(true, "win32")).toEqual({ openAtLogin: true, args: [WINDOWS_LOGIN_ARG] });
    expect(loginItemSettings(false, "win32")).toEqual({ openAtLogin: false, args: [WINDOWS_LOGIN_ARG] });
    expect(loginItemSettings(true, "darwin")).toEqual({ openAtLogin: true });
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
