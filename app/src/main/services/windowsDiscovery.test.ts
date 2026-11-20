import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { propertyParams } from "../../shared/testing/property";
import { discoverWindowsPrinters, parseWindowsPrinterProbe, usbPrintInstanceOnPort, windowsZebraInstanceId } from "./windowsDiscovery";

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
      pnpDeviceId: printer.pnpDeviceId, verifiedUsbSerial: null, serialEvidence: null, selectionKey: null,
      queueState: "available", problems: ["serial-unverified"],
    }]);
  });

  it("ignores an unrelated queue with an unusable field instead of failing the whole inventory", () => {
    const other = { ...printer, queueName: "Office Laser", driverName: "Generic", pnpDeviceId: null };
    for (const patch of [{ portName: "" }, { driverName: "" }, { isLocal: null }, { workOffline: null }]) {
      const report = parseWindowsPrinterProbe(probe([{ ...other, ...patch }, printer]));
      expect(report.inspectedQueues).toBe(2);
      expect(report.candidates.map((candidate) => candidate.queueName)).toEqual([printer.queueName]);
    }
  });

  it("still fails closed when the unreadable row could be a Zebra or does not name a queue", () => {
    for (const row of [{ ...printer, portName: "" }, { ...printer, queueName: "Floor 2", driverName: "ZDesigner ZD421", portName: "" }, { queueName: "Floor 2", pnpDeviceId: "USB\\VID_0A5F&PID_0185\\X", portName: "" }, { portName: "USB001" }, "text", null]) {
      expect(() => parseWindowsPrinterProbe(probe([row, printer]))).toThrow("invalid-probe");
    }
  });

  it("fails closed on an unreadable row that carries serial evidence, so duplicate checks still see it", () => {
    const verified = { ...printer, verifiedUsbSerial: "D2J190800123", serialEvidence: "unique-usb-parent" };
    const plain = { queueName: "Floor 2", driverName: "Generic", pnpDeviceId: null, portName: "" };
    for (const evidence of [{ verifiedUsbSerial: "D2J190800123" }, { serialEvidence: "unique-usb-parent" }, { serialEvidence: "source-unknown" }, { usbPrintInstanceId: "USBPRINT\\X\\1&0&USB009" }]) {
      expect(() => parseWindowsPrinterProbe(probe([{ ...printer, ...plain, ...evidence }, verified]))).toThrow("invalid-probe");
    }
    // No evidence at all: the unrelated row is still skipped.
    expect(parseWindowsPrinterProbe(probe([{ ...printer, ...plain, verifiedUsbSerial: null, serialEvidence: null }, verified])).candidates).toHaveLength(1);
  });

  it("fails closed on an unreadable row whose only Zebra evidence is a USBPRINT ZTC or ZEBRA PnP ID", () => {
    for (const pnpDeviceId of ["USBPRINT\\ZTCZD421\\7&1234&0&USB002", "USBPRINT\\ZEBRA_ZD421\\7&1234&0&USB002"]) {
      const row = { ...printer, queueName: "Floor 2", driverName: "Generic", portName: "", pnpDeviceId };
      expect(() => parseWindowsPrinterProbe(probe([row, printer]))).toThrow("invalid-probe");
    }
  });

  it("allows queue names up to the spooler helper's 127 characters and flags longer ones the probe still reads", () => {
    const named = (length: number) => `Zebra${"x".repeat(length - 5)}`;
    expect(parseWindowsPrinterProbe(probe([{ ...printer, queueName: named(127) }])).candidates[0].problems).not.toContain("unsupported-queue-name");
    for (const length of [128, 256]) {
      expect(parseWindowsPrinterProbe(probe([{ ...printer, queueName: named(length) }])).candidates[0].problems).toContain("unsupported-queue-name");
    }
    // Past the probe's own 256-character field limit the row is unreadable, and a Zebra-like row fails closed.
    expect(() => parseWindowsPrinterProbe(probe([{ ...printer, queueName: named(257) }]))).toThrow("invalid-probe");
  });

  it("flags a queue name that printing would refuse, so it is never offered for pairing", () => {
    for (const queueName of ["Kids Zebra #1", "Zebra \u2013 Lobby", "-Zebra", "Zebra\"", "Zebra$"]) {
      const [candidate] = parseWindowsPrinterProbe(probe([{ ...printer, queueName }])).candidates;
      expect(candidate.problems).toContain("unsupported-queue-name");
      expect(candidate.selectionKey).toBeNull();
    }
    const [ok] = parseWindowsPrinterProbe(probe([printer])).candidates;
    expect(ok.problems).not.toContain("unsupported-queue-name");
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
    expect(report.candidates[0].problems).toEqual(["hardware-id-unverified", "serial-unverified"]);
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
      [{ printerStatus: null }, "unknown"], [{ detectedErrorState: null }, "unknown"], [{ detectedErrorState: 1 }, "unknown"],
      [{ printerStatus: 7, detectedErrorState: 0 }, "offline"], [{ workOffline: true, detectedErrorState: 0 }, "offline"],
      [{ printerStatus: 65535 }, "unknown"], [{ detectedErrorState: 65535 }, "unknown"],
    ] as const) {
      const candidate = parseWindowsPrinterProbe(probe([{ ...printer, ...patch }])).candidates[0];
      expect(candidate.queueState).toBe(expected);
      expect(candidate.selectionKey).toBeNull();
    }
  });

  it("enables only proven unique USB parents, not spooler names or synthetic PnP instance tails", () => {
    const verified = { ...printer, usbPrintInstanceId: printer.pnpDeviceId, verifiedUsbSerial: "D2J190800123", serialEvidence: "unique-usb-parent" };
    expect(parseWindowsPrinterProbe(probe([verified])).candidates[0]).toMatchObject({
      verifiedUsbSerial: "D2J190800123", serialEvidence: "unique-usb-parent", selectionKey: `windows-pnp:${printer.pnpDeviceId.toUpperCase()}`, problems: [],
    });
    for (const patch of [
      { serialEvidence: null }, { serialEvidence: "source-unknown" }, { verifiedUsbSerial: "6&123&0&USB001" },
      { verifiedUsbSerial: null }, { verifiedUsbSerial: "new\nline" },
    ]) {
      const raw = { ...verified, ...patch };
      if (raw.verifiedUsbSerial === "new\nline") {
        expect(() => parseWindowsPrinterProbe(probe([raw]))).toThrow("invalid-probe");
      } else {
        const candidate = parseWindowsPrinterProbe(probe([raw])).candidates[0];
        expect(candidate.selectionKey).toBeNull();
        expect(candidate.problems).toContain("serial-unverified");
      }
    }
    const other = "USBPRINT\\Zebra_TechnologiesZTCZD421\\7&9999&0&USB002";
    const duplicated = parseWindowsPrinterProbe(probe([verified, { ...verified, queueName: "Second Zebra", portName: "USB002", pnpDeviceId: other, usbPrintInstanceId: other }])).candidates;
    expect(duplicated.every((row) => row.problems.includes("duplicate-usb-serial") && row.selectionKey === null)).toBe(true);
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
      expect(parseWindowsPrinterProbe(probe([row])).candidates[0].selectionKey).toBeNull();
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
      // Execution policy refused the script: nothing ran, which is not an empty inventory.
      [{ ...ok, code: 1, stdout: "", stderr: "File C:\\x.ps1 cannot be loaded.\r\n    + FullyQualifiedErrorId : UnauthorizedAccess\r\n" }, "policy-blocked"],
      [{ ...ok, code: 2, stdout: "", stderr: "    + FullyQualifiedErrorId : UnauthorizedAccess\r\n" }, "probe-failed"],
    ] as const) {
      const run = vi.fn().mockResolvedValue(result);
      await expect(discoverWindowsPrinters({ platform: "win32", run, ...paths })).rejects.toMatchObject({ reason });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

// Captured on Windows 11 with a Zebra ZD421 on the official ZDesigner driver (2026-11-20), as the probe now
// reports it. Win32_Printer leaves PNPDeviceID empty for this driver and reports an idle queue as PrinterStatus 3
// with DetectedErrorState 0, like the PC's other local queues.
const REAL_USBPRINT = "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB001";
const realZd421 = {
  queueName: "ZDesigner ZD421-203dpi ZPL", driverName: "ZDesigner ZD421-203dpi ZPL", portName: "USB001",
  pnpDeviceId: null, usbPrintInstanceId: REAL_USBPRINT, verifiedUsbSerial: "D8J253115309", serialEvidence: "usbprint-port",
  isLocal: true, isNetwork: false, workOffline: false, printerStatus: 3, detectedErrorState: 0,
  printerState: 0, extendedDetectedErrorState: 0,
};
const realOthers = [
  { queueName: "OneNote (Desktop)", driverName: "Send to Microsoft OneNote 16 Driver", portName: "nul:", pnpDeviceId: null, usbPrintInstanceId: null, verifiedUsbSerial: null, serialEvidence: null, isLocal: true, isNetwork: false, workOffline: false, printerStatus: 3, detectedErrorState: 0 },
  { queueName: "Microsoft Print to PDF", driverName: "Microsoft Print To PDF", portName: "PORTPROMPT:", pnpDeviceId: null, usbPrintInstanceId: null, verifiedUsbSerial: null, serialEvidence: null, isLocal: true, isNetwork: false, workOffline: false, printerStatus: 3, detectedErrorState: 0 },
];

describe("real ZD421 on the ZDesigner driver (empty PNPDeviceID, DetectedErrorState 0)", () => {
  it("offers the Zebra with its USB serial and a ready queue, and ignores the other queues", () => {
    const report = parseWindowsPrinterProbe(probe([...realOthers, realZd421]));
    expect(report.inspectedQueues).toBe(3);
    expect(report.candidates).toEqual([{
      queueName: realZd421.queueName, driverName: realZd421.driverName, portName: "USB001",
      pnpDeviceId: null, verifiedUsbSerial: "D8J253115309", serialEvidence: "usbprint-port",
      selectionKey: `windows-pnp:${REAL_USBPRINT}`, queueState: "available", problems: [],
    }]);
  });

  it("refuses a port-found serial when the USBPRINT device is on another port", () => {
    for (const patch of [
      { portName: "USB002" },
      { usbPrintInstanceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB002" },
      { portName: "USB00", usbPrintInstanceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB001" },
      { portName: "USB002", usbPrintInstanceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB0021" },
      { usbPrintInstanceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0USB001" },
      { usbPrintInstanceId: null }, { usbPrintInstanceId: "USB\\VID_0A5F&PID_0185\\D8J253115309" },
      { usbPrintInstanceId: "USBPRINT\\HP_LASER\\6&1DBA03D&0&USB001" },
    ]) {
      const [candidate] = parseWindowsPrinterProbe(probe([{ ...realZd421, ...patch }])).candidates;
      expect(candidate.verifiedUsbSerial).toBeNull();
      expect(candidate.serialEvidence).toBeNull();
      expect(candidate.selectionKey).toBeNull();
      expect(candidate.problems).toContain("serial-unverified");
    }
  });

  it("cross-checks the evidence against PNPDeviceID (review F1)", () => {
    // Port evidence is only valid when Windows gave no PNPDeviceID.
    const portWithPnp = parseWindowsPrinterProbe(probe([{ ...realZd421, pnpDeviceId: REAL_USBPRINT }])).candidates[0];
    expect(portWithPnp.problems).toContain("serial-unverified");
    // A PNPDeviceID walk must be from the very USBPRINT device on the queue's port.
    const pnp = { ...realZd421, pnpDeviceId: REAL_USBPRINT, serialEvidence: "unique-usb-parent" };
    expect(parseWindowsPrinterProbe(probe([pnp])).candidates[0]).toMatchObject({ verifiedUsbSerial: "D8J253115309", serialEvidence: "unique-usb-parent", problems: [] });
    for (const patch of [
      { pnpDeviceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&99&0&USB001" },
      { pnpDeviceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB002", usbPrintInstanceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB002" },
      { pnpDeviceId: "USB\\VID_0A5F&PID_0185\\D8J253115309", usbPrintInstanceId: "USB\\VID_0A5F&PID_0185\\D8J253115309" },
      { pnpDeviceId: null },
    ]) {
      expect(parseWindowsPrinterProbe(probe([{ ...pnp, ...patch }])).candidates[0].problems).toContain("serial-unverified");
    }
  });

  it("blocks two queues that claim the same port-found device", () => {
    const candidates = parseWindowsPrinterProbe(probe([realZd421, { ...realZd421, queueName: "Zebra copy" }])).candidates;
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.selectionKey).toBeNull();
      expect(candidate.problems).toEqual(expect.arrayContaining(["duplicate-hardware-id", "duplicate-usb-serial"]));
    }
  });

  it("matches the port only as the whole last segment of a Zebra USBPRINT ID", () => {
    expect(usbPrintInstanceOnPort(REAL_USBPRINT, "USB001")).toBe(true);
    expect(usbPrintInstanceOnPort(REAL_USBPRINT.toLowerCase(), "usb001")).toBe(true);
    for (const [id, port] of [
      [REAL_USBPRINT, "USB002"], [REAL_USBPRINT, "USB01"], [REAL_USBPRINT, "SB001"], [REAL_USBPRINT, "nul:"],
      [`${REAL_USBPRINT}1`, "USB001"], [null, "USB001"], ["USB\\VID_0A5F&PID_0185\\X&USB001", "USB001"],
    ] as const) {
      expect(usbPrintInstanceOnPort(id, port)).toBe(false);
    }
  });

  it("treats DetectedErrorState 0 as ready only while idle, printing, or warming up and not offline", () => {
    for (const printerStatus of [3, 4, 5]) {
      expect(parseWindowsPrinterProbe(probe([{ ...realZd421, printerStatus }])).candidates[0].queueState).toBe("available");
    }
    for (const [patch, expected] of [
      [{ printerStatus: 7 }, "offline"], [{ workOffline: true }, "offline"], [{ printerStatus: 1 }, "unknown"],
      [{ printerStatus: 2 }, "unknown"], [{ printerStatus: null }, "unknown"], [{ detectedErrorState: 1 }, "unknown"],
      [{ detectedErrorState: 4 }, "attention"], [{ detectedErrorState: 6 }, "attention"], [{ detectedErrorState: 7 }, "attention"],
      [{ detectedErrorState: 9 }, "offline"], [{ detectedErrorState: null }, "unknown"],
    ] as const) {
      expect(parseWindowsPrinterProbe(probe([{ ...realZd421, ...patch }])).candidates[0].queueState).toBe(expected);
    }
  });

  // DetectedErrorState 0 is "the driver reports no status", so PrinterState (PRINTER_STATUS_* bits) and
  // ExtendedDetectedErrorState must still turn the queue away. Not yet captured on hardware: synthetic values.
  const stateOf = (patch: Record<string, unknown>) => parseWindowsPrinterProbe(probe([{ ...realZd421, ...patch }])).candidates[0].queueState;

  it("keeps the real idle values (PrinterState 0, ExtendedDetectedErrorState 0) available", () => {
    expect(stateOf({})).toBe("available");
  });

  it("keeps the old rule when an older probe omits PrinterState or reports it as null", () => {
    const older = Object.fromEntries(Object.entries(realZd421).filter(([key]) => key !== "printerState" && key !== "extendedDetectedErrorState"));
    expect(older).not.toHaveProperty("printerState");
    expect(parseWindowsPrinterProbe(probe([older])).candidates[0].queueState).toBe("available");
    expect(stateOf({ printerState: null, extendedDetectedErrorState: null })).toBe("available");
    expect(stateOf({ printerState: null, printerStatus: 7 })).toBe("offline");
  });

  it("needs attention for paused, error, paper, door, toner, memory, and intervention bits", () => {
    for (const bit of [0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x800, 0x40000, 0x80000, 0x100000, 0x200000, 0x400000, 0x4000000]) {
      expect([bit, stateOf({ printerState: bit })]).toEqual([bit, "attention"]);
      expect([bit, stateOf({ printerState: bit | 0x400 })]).toEqual([bit, "attention"]);
    }
  });

  it("is offline for offline, not-available, and server bits, ahead of any attention bit", () => {
    for (const bit of [0x80, 0x1000, 0x800000, 0x2000000]) {
      expect([bit, stateOf({ printerState: bit })]).toEqual([bit, "offline"]);
      expect([bit, stateOf({ printerState: bit | 0x1 | 0x10 })]).toEqual([bit, "offline"]);
    }
  });

  it("stays available for busy, printing, warming-up, toner-low, and power-save bits", () => {
    for (const bit of [0x100, 0x200, 0x400, 0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x1000000]) {
      expect([bit, stateOf({ printerState: bit })]).toEqual([bit, "available"]);
    }
  });

  it("does not call a queue available when PrinterState has a bit this code does not name", () => {
    for (const bit of [0x8000000, 0x80000000]) expect([bit, stateOf({ printerState: bit })]).toEqual([bit, "unknown"]);
    expect(stateOf({ printerState: 0xffffffff })).toBe("offline");
  });

  it("needs attention for any non-zero ExtendedDetectedErrorState", () => {
    for (const extendedDetectedErrorState of [1, 2, 3, 7, 65535]) {
      expect([extendedDetectedErrorState, stateOf({ extendedDetectedErrorState })]).toEqual([extendedDetectedErrorState, "attention"]);
    }
    expect(stateOf({ extendedDetectedErrorState: 3, workOffline: true })).toBe("offline");
  });

  it("fails closed on a PrinterState or ExtendedDetectedErrorState outside its CIM type", () => {
    for (const patch of [
      { printerState: -1 }, { printerState: 0x100000000 }, { printerState: 1.5 }, { printerState: "0" },
      { extendedDetectedErrorState: -1 }, { extendedDetectedErrorState: 65536 }, { extendedDetectedErrorState: "0" },
    ]) {
      expect(() => parseWindowsPrinterProbe(probe([{ ...realZd421, ...patch }]))).toThrow("invalid-probe");
    }
  });
});

// The .ps1 port binding and status fields are only checked as text here: PowerShell does not run in this suite, so
// a logic error the assertions below do not spell out would only show on a Windows PC (review nit).
describe("probe script port binding (read as text; PowerShell does not run here)", () => {
  const script = readFileSync(new URL("../../../../scripts/windows/probe-printers.ps1", import.meta.url), "utf8");
  const fn = (name: string) => {
    const start = script.indexOf(`function ${name}`);
    expect(start).toBeGreaterThanOrEqual(0);
    return script.slice(start, script.indexOf("\n}\n", start));
  };

  it("ties a USBPRINT device to a queue only by an '&' + PortName suffix, case-insensitively", () => {
    const test = fn("Test-UsbPrintInstanceOnPort");
    expect(test).toContain("$portName -notmatch '^USB[0-9]{3,}$'");
    expect(test).toContain("$instanceId.StartsWith('USBPRINT\\', [System.StringComparison]::OrdinalIgnoreCase)");
    expect(test).toContain("$instanceId.EndsWith('&' + $portName, [System.StringComparison]::OrdinalIgnoreCase)");
  });

  it("requires exactly one present, working USBPRINT device on the port", () => {
    const select = fn("Select-UsbPrintInstanceForPort");
    expect(select).toContain("Where-Object { Test-UsbPrintInstanceOnPort $_ $portName }");
    expect(select).toContain("if ($found.Count -ne 1) { return $null }");
    const present = fn("Get-PresentUsbPrintInstanceIds");
    expect(present).toContain("Get-PnpDevice -PresentOnly -ErrorAction Stop");
    expect(present).toContain("$_.Status -eq 'OK'");
    expect(present).toContain("catch { $script:presentUsbPrintIds = @() }");
  });

  it("uses the port lookup only for an empty PNPDeviceID and cross-checks a present one", () => {
    expect(script).toContain("if ([string]::IsNullOrWhiteSpace($pnp)) {\n                $usbPrint = Select-UsbPrintInstanceForPort $port (Get-PresentUsbPrintInstanceIds)");
    expect(script).toContain("} elseif (Test-UsbPrintInstanceOnPort $pnp $port) {");
    expect(script).toContain("if ($null -ne $serial) { $evidence = 'usbprint-port' }");
    expect(script).toContain("if ($null -ne $serial) { $evidence = 'unique-usb-parent' }");
    expect(script).toContain("usbPrintInstanceId = $usbPrint");
    // Both paths still need the Zebra USB parent with CM_DEVCAP_UNIQUEID.
    expect(fn("Get-VerifiedZebraUsbSerial")).toContain("([int]$cap.Data -band 16) -ne 16");
    expect(script.match(/Get-VerifiedZebraUsbSerial \$/g)).toHaveLength(2);
  });

  it("stays read-only and does not bypass execution policy", () => {
    expect(script).not.toMatch(/\b(?:Set|Remove|Add|Enable|Disable|Install|Uninstall|Restart|Invoke|Start|Stop)-[A-Z]|\bNew-(?!Object\b)/);
    expect(script).not.toMatch(/Bypass|Unrestricted/i);
  });

  it("reports PrinterState as a full uint32 and ExtendedDetectedErrorState, null when Windows has none", () => {
    expect(script).toContain("printerState = if ($null -eq $queue.PrinterState) { $null } else { [int64]$queue.PrinterState }");
    expect(script).toContain(
      "extendedDetectedErrorState = if ($null -eq $queue.ExtendedDetectedErrorState) { $null } else { [int]$queue.ExtendedDetectedErrorState }",
    );
    expect(script).toContain("schemaVersion = 1");
  });
});
