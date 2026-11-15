import { describe, expect, it, vi } from "vitest";

import { detectLoginLaunch, shouldShowWindowAtLaunch, type LaunchWindowInput } from "./launch";

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
});
