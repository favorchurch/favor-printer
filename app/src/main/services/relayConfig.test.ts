import { afterEach, describe, expect, it, vi } from "vitest";

import { parseParentMessage } from "../../../../vendor/relay/embeddedProtocol";
import { appSupportDir, buildRelayStartOptions, DEFAULT_API_URL, type RelayConfigInput } from "./relayConfig";

const input = (overrides: Partial<RelayConfigInput> = {}): RelayConfigInput => ({
  credentials: { relayId: "relay-1", token: "tok-super-secret-123" },
  queue: "Favor_D2J190800123",
  appSupportDir: appSupportDir("/Users/volunteer"),
  appVersion: "0.1.0",
  osVersion: "26.0",
  printerAttached: true,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appSupportDir", () => {
  it("is the Favor Printer folder under Application Support", () => {
    expect(appSupportDir("/Users/volunteer")).toBe("/Users/volunteer/Library/Application Support/Favor Printer");
  });
});

describe("Windows relay path", () => {
  it("uses an existing Windows RAW queue, fixed local packaged helper, and standard app data", () => {
    expect(appSupportDir("C:\\Users\\volunteer", "win32", "C:\\Users\\volunteer\\AppData\\Roaming")).toBe("C:\\Users\\volunteer\\AppData\\Roaming\\Favor Printer");
    const options = buildRelayStartOptions(input({
      platform: "win32", appSupportDir: "C:\\Users\\volunteer\\AppData\\Roaming\\Favor Printer",
      queue: "Zebra ZD421", windowsScriptPath: "C:\\Program Files\\Favor Printer\\resources\\windows\\print-raw.ps1",
    }));
    expect(options.transport).toEqual({ kind: "windows", queue: "Zebra ZD421", scriptPath: "C:\\Program Files\\Favor Printer\\resources\\windows\\print-raw.ps1" });
    expect(parseParentMessage({ type: "start", options })?.type).toBe("start");
    for (const scriptPath of ["print-raw.ps1", "\\\\server\\helper.ps1", "C:\\scripts\\bad\n.ps1"]) {
      expect(() => buildRelayStartOptions(input({ platform: "win32", queue: "Zebra ZD421", windowsScriptPath: scriptPath }))).toThrow();
    }
  });
});

describe("buildRelayStartOptions", () => {
  it("matches the relay start options snapshot", () => {
    expect(buildRelayStartOptions(input())).toEqual({
      apiUrl: "https://rsvp.favor.church",
      relayId: "relay-1",
      token: "tok-super-secret-123",
      spoolDir: "/Users/volunteer/Library/Application Support/Favor Printer/spool",
      transport: { kind: "cups", queue: "Favor_D2J190800123" },
      appVersion: "0.1.0",
      osVersion: "26.0",
      printerAttached: true,
    });
  });

  it("points at the production cloud unless told otherwise", () => {
    expect(DEFAULT_API_URL).toBe("https://rsvp.favor.church");
    expect(buildRelayStartOptions(input({ apiUrl: "http://localhost:3000" })).apiUrl).toBe("http://localhost:3000");
  });

  it("carries the attached flag as given", () => {
    expect(buildRelayStartOptions(input({ printerAttached: false })).printerAttached).toBe(false);
  });

  it("is assembled in memory: no RELAY_ variable is read or produced", () => {
    vi.stubEnv("RELAY_TOKEN", "from-the-environment");
    vi.stubEnv("RELAY_API_URL", "https://evil.example");
    vi.stubEnv("RELAY_CUPS_QUEUE", "Elsewhere");
    vi.stubEnv("RELAY_SPOOL_DIR", "/tmp/elsewhere");

    const options = buildRelayStartOptions(input());
    const text = JSON.stringify(options);

    expect(text).not.toContain("RELAY_");
    expect(text).not.toContain("from-the-environment");
    expect(options.apiUrl).toBe("https://rsvp.favor.church");
    expect(options.transport).toEqual({ kind: "cups", queue: "Favor_D2J190800123" });
    expect(options.spoolDir).toContain("/Library/Application Support/Favor Printer/spool");
  });

  it("is accepted by the relay's own message parser", () => {
    const message = parseParentMessage({ type: "start", options: buildRelayStartOptions(input()) });
    expect(message?.type).toBe("start");
  });

  it("refuses a queue name the relay would refuse, without echoing the token", () => {
    for (const queue of ["-evil", "two words", "", "a;b"]) {
      let message = "";
      try {
        buildRelayStartOptions(input({ queue }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, queue).not.toBe("");
      expect(message).not.toContain("tok-super-secret-123");
    }
  });

  it("refuses plain http to a remote host", () => {
    expect(() => buildRelayStartOptions(input({ apiUrl: "http://rsvp.favor.church" }))).toThrow(/https/);
  });
});
