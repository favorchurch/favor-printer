import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { propertyParams } from "../../shared/testing/property";
import { discoverWindowsPrinters, parseWindowsPrinterProbe, windowsZebraInstanceId } from "./windowsDiscovery";

const printer = {
  queueName: "Favor Zebra",
  driverName: "ZDesigner ZD421-203dpi ZPL",
  portName: "USB001",
  pnpDeviceId: "USBPRINT\\Zebra_TechnologiesZTCZD421\\7&1234&0&USB001",
  isLocal: true,
  isNetwork: false,
  workOffline: false,
  printerStatus: 3,
  detectedErrorState: 2,
};
const probe = (printers: unknown[]) => JSON.stringify({ schemaVersion: 1, source: "Win32_Printer", printers });

describe("Windows discovery identity and queue observations", () => {
  it("recognizes a local Zebra instance without creating a cloud UUID or asserting physical readiness", () => {
    const report = parseWindowsPrinterProbe(probe([printer]));
    expect(report.inspectedQueues).toBe(1);
    expect(report.candidates).toEqual([{
      queueName: printer.queueName, driverName: printer.driverName, portName: "USB001",
      pnpDeviceId: printer.pnpDeviceId, selectionKey: `windows-pnp:${printer.pnpDeviceId.toUpperCase()}`,
      queueState: "available", problems: [],
    }]);
  });

  it("distinguishes a successful empty inventory from a malformed or partial response", () => {
    expect(parseWindowsPrinterProbe(probe([]))).toEqual({ inspectedQueues: 0, candidates: [] });
    for (const value of ["", "Access denied", "null", "[]", "{}", JSON.stringify({ schemaVersion: 1, source: "Win32_Printer", printers: printer }), probe([{}])]) {
      expect(() => parseWindowsPrinterProbe(value)).toThrow("invalid-probe");
    }
  });

  it("ignores non-Zebra queues but never treats a Zebra label as hardware identity", () => {
    const report = parseWindowsPrinterProbe(probe([
      { ...printer, queueName: "Office Laser", driverName: "Generic", pnpDeviceId: null },
      { ...printer, pnpDeviceId: "SWD\\PRINTENUM\\{some-queue}" },
    ]));
    expect(report.inspectedQueues).toBe(2);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].selectionKey).toBeNull();
    expect(report.candidates[0].problems).toEqual(["hardware-id-unverified"]);
  });

  it("does not infer identity from queue names or reused USB ports", () => {
    for (const pnpDeviceId of [null, "", "Favor Zebra", "USB001", "USB\\VID_1234&PID_5678\\123", "USBPRINT\\HP_Laser\\123"]) {
      expect(parseWindowsPrinterProbe(probe([{ ...printer, pnpDeviceId }])).candidates[0].selectionKey).toBeNull();
    }
  });

  it("rejects non-ASCII and control-bearing PnP identifiers before case normalization", () => {
    for (const value of ["UſB\\VID_0A5F&PID_0185\\123", "USB\\VID_0A5F&PID_0185\\123\n", " USB\\VID_0A5F&PID_0185\\123"]) {
      expect(windowsZebraInstanceId(value)).toBeNull();
    }
  });

  it("refuses network, nonlocal, pooled, TCP, and file queues", () => {
    for (const patch of [{ isNetwork: true }, { isLocal: false }, { portName: "USB001,USB002" }, { portName: "IP_192.0.2.1" }, { portName: "FILE:" }]) {
      const candidate = parseWindowsPrinterProbe(probe([{ ...printer, ...patch }])).candidates[0];
      expect(candidate.selectionKey).toBeNull();
      expect(candidate.problems.length).toBeGreaterThan(0);
    }
  });

  it("invalidates both aliases of the same physical instance instead of choosing the first", () => {
    const candidates = parseWindowsPrinterProbe(probe([printer, { ...printer, queueName: "Other queue", pnpDeviceId: printer.pnpDeviceId.toLowerCase() }])).candidates;
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.selectionKey).toBeNull();
      expect(candidate.problems).toContain("duplicate-hardware-id");
    }
  });

  it("blocks duplicate queue names even when the conflicting queue is not a Zebra", () => {
    const candidates = parseWindowsPrinterProbe(probe([printer, {
      ...printer, queueName: printer.queueName.toLowerCase(), driverName: "Generic", pnpDeviceId: null,
    }])).candidates;
    expect(candidates[0].selectionKey).toBeNull();
    expect(candidates[0].problems).toContain("duplicate-queue-name");
  });

  it("keeps offline/error/unknown queue observations separate from a usable instance id", () => {
    for (const [patch, expected] of [
      [{ workOffline: true }, "offline"], [{ printerStatus: 7 }, "offline"], [{ detectedErrorState: 9 }, "offline"],
      [{ printerStatus: 6 }, "attention"], [{ detectedErrorState: 8 }, "attention"],
      [{ printerStatus: null }, "unknown"], [{ detectedErrorState: null }, "unknown"],
      [{ printerStatus: 65535 }, "unknown"], [{ detectedErrorState: 65535 }, "unknown"],
    ] as const) {
      const candidate = parseWindowsPrinterProbe(probe([{ ...printer, ...patch }])).candidates[0];
      expect(candidate.queueState).toBe(expected);
      expect(candidate.selectionKey).not.toBeNull();
    }
  });

  it("accepts a UTF-8 BOM but rejects oversized, control-bearing, or mistyped data", () => {
    expect(parseWindowsPrinterProbe(`\uFEFF${probe([printer])}`).candidates).toHaveLength(1);
    for (const patch of [{ queueName: "bad\nname" }, { driverName: "" }, { isLocal: "true" }, { workOffline: null }, { printerStatus: -1 }, { portName: " USB001" }]) {
      expect(() => parseWindowsPrinterProbe(probe([{ ...printer, ...patch }]))).toThrow("invalid-probe");
    }
    expect(() => parseWindowsPrinterProbe(probe(Array(257).fill(printer)))).toThrow("invalid-probe");
    expect(() => parseWindowsPrinterProbe(" ".repeat(256 * 1024 + 1))).toThrow("invalid-probe");
  });

  it("has case-insensitive local identity across arbitrary safe device suffixes", () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Z0-9]{1,32}$/), (suffix) => {
      const id = `USB\\VID_0A5F&PID_0185\\${suffix}`;
      expect(windowsZebraInstanceId(id.toLowerCase())).toBe(id);
    }), propertyParams());
  });

  it("cannot change identity by renaming a queue or changing its USB port", () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9]{1,32}$/), fc.integer({ min: 1, max: 999 }), (name, port) => {
      const row = { ...printer, queueName: name, portName: `USB${String(port).padStart(3, "0")}` };
      expect(parseWindowsPrinterProbe(probe([row])).candidates[0].selectionKey).toBe(`windows-pnp:${printer.pnpDeviceId.toUpperCase()}`);
    }), propertyParams());
  });
});

describe("Windows probe process boundary", () => {
  const paths = { powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", probePath: "C:\\Favor Printer\\probe-printers.ps1" };
  const ok = { code: 0, stdout: probe([printer]), stderr: "", timedOut: false };

  it("runs only the fixed read-only script via argument array, without execution-policy bypass", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    const report = await discoverWindowsPrinters({ platform: "win32", run, ...paths });
    expect(report.candidates).toHaveLength(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(paths.powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", paths.probePath], { timeoutMs: 15_000 });
  });

  it("cannot invoke a process on another platform or with remote/relative script paths", async () => {
    const run = vi.fn();
    await expect(discoverWindowsPrinters({ platform: "linux", run, ...paths })).rejects.toMatchObject({ reason: "unsupported-platform" });
    for (const probePath of ["probe.ps1", "\\\\server\\share\\probe.ps1", "C:\\bad\nfile.ps1"]) {
      await expect(discoverWindowsPrinters({ platform: "win32", run, ...paths, probePath })).rejects.toMatchObject({ reason: "invalid-path" });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("does not reinterpret a failed, killed, or timed-out probe as no printers", async () => {
    for (const [result, reason] of [
      [{ ...ok, code: 1 }, "probe-failed"], [{ ...ok, code: null }, "probe-failed"], [{ ...ok, timedOut: true }, "probe-timeout"],
      [{ ...ok, stdout: "not-json" }, "invalid-probe"],
    ] as const) {
      const run = vi.fn().mockResolvedValue(result);
      await expect(discoverWindowsPrinters({ platform: "win32", run, ...paths })).rejects.toMatchObject({ reason });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});
