import { describe, expect, it } from "vitest";

import { noLegacyMacAgent, windowsResourcePaths, WINDOWS_POWERSHELL } from "./windowsPlatform";

describe("Windows native host platform boundaries", () => {
  const projectDir = "C:\\favor-printer";
  const resourcesDir = "C:\\Program Files\\Favor Printer\\resources";
  it("loads the exact app-owned scripts from immutable packaged resources", () => {
    const actual = windowsResourcePaths({ packaged: true, resourcesDir, projectDir });
    expect(actual).toEqual({
      powershellPath: WINDOWS_POWERSHELL,
      probePath: "C:\\Program Files\\Favor Printer\\resources\\windows\\probe-printers.ps1",
      printPath: "C:\\Program Files\\Favor Printer\\resources\\windows\\print-raw.ps1",
    });
  });
  it("uses the repository scripts only for development", () => {
    const actual = windowsResourcePaths({ packaged: false, resourcesDir, projectDir });
    expect(actual.probePath).toBe("C:\\favor-printer\\scripts\\windows\\probe-printers.ps1");
    expect(actual.printPath).toBe("C:\\favor-printer\\scripts\\windows\\print-raw.ps1");
  });
  it("never invokes launchctl or tries to move a Mac launch agent on Windows", async () => {
    const legacy = noLegacyMacAgent();
    expect(await legacy.detect()).toEqual({ loaded: false, plistPresent: false });
    expect(await legacy.canStartRelay()).toEqual({ allowed: true });
    expect(await legacy.migrate()).toEqual({ ok: true });
  });
});
