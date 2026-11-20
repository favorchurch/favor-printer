import { describe, expect, it, vi } from "vitest";

import { createWindowsPrinterService, eligibleWindowsZebras, POWERSHELL_BLOCKED_WARNING, WINDOWS_SCAN_FAILED_WARNING, windowsUnusableZebraNotice } from "./windowsPrinterService";
import { parseWindowsPrinterProbe } from "./windowsDiscovery";
import type { CommandRunner } from "./command";

const DEVICE = "USBPRINT\\Zebra_TechnologiesZTCZD421\\7&ABCDEF&0&USB001";
const row = (change: Record<string, unknown> = {}) => ({
  queueName: "Zebra ZD421", driverName: "ZDesigner ZD421-203dpi ZPL", portName: "USB001",
  pnpDeviceId: DEVICE, verifiedUsbSerial: "ZD421A01", serialEvidence: "unique-usb-parent",
  isLocal: true, isNetwork: false, workOffline: false, printerStatus: 3, detectedErrorState: 2,
  // As the probe reports a PNPDeviceID on the queue's own port: the same ID is the port-bound USBPRINT device.
  usbPrintInstanceId: "pnpDeviceId" in change ? change.pnpDeviceId : DEVICE,
  ...change,
});
const response = (...printers: unknown[]) => JSON.stringify({ schemaVersion: 1, source: "Win32_Printer", printers });
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
const input = (run: CommandRunner) => ({
  platform: "win32" as const, run,
  powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  probePath: "C:\\Program Files\\Favor Printer\\resources\\windows\\probe-printers.ps1",
});

describe("Windows printer host binding", () => {
  it("selects the sole verified USB Zebra and returns its existing Windows spooler queue", async () => {
    const run = vi.fn().mockResolvedValue(ok(response(row())));
    const service = createWindowsPrinterService(input(run));
    const scanned = await service.scan(null);
    expect(scanned).toEqual({
      scan: { kind: "found", devices: [{
        id: `windows-pnp:${DEVICE.toUpperCase()}`, deviceUri: `windows-pnp:${DEVICE.toUpperCase()}`,
        usbSerial: "ZD421A01", model: "ZDesigner ZD421-203dpi ZPL",
      }], selectedId: `windows-pnp:${DEVICE.toUpperCase()}`, queue: "ready" },
      queue: "Zebra ZD421", listFailed: false,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-File", input(run).probePath]);
  });

  it("never infers a hardware serial from synthetic PnP, USB001, or a renamed queue", async () => {
    for (const change of [{ verifiedUsbSerial: null, serialEvidence: null }, { serialEvidence: null }, { portName: "IP_127.0.0.1" }, { isNetwork: true }]) {
      const service = createWindowsPrinterService(input(vi.fn().mockResolvedValue(ok(response(row(change))))));
      expect((await service.scan(null)).scan).toMatchObject({ kind: "none" });
    }
  });

  describe("a Zebra queue that cannot be used says what to change, not 'plug in a Zebra'", () => {
    const scanOf = async (...printers: unknown[]) => (await createWindowsPrinterService(input(vi.fn().mockResolvedValue(ok(response(...printers))))).scan(null));

    it("asks to rename a queue name printing would refuse, naming the allowed characters", async () => {
      const outcome = await scanOf(row({ queueName: "Kids Zebra #1" }));
      expect(outcome).toMatchObject({ queue: null, listFailed: false });
      expect(outcome.scan).toEqual({
        kind: "none",
        notice: 'Favor Printer cannot print to a queue named "Kids Zebra #1". In Printers & scanners, rename it so it starts with a letter or number, does not end with a space, and uses only letters, numbers, spaces and _ ( ) . - (up to 127 characters).',
      });
    });

    it.each([
      ["serial-unverified", { verifiedUsbSerial: null, serialEvidence: null }, "cannot read the USB serial number"],
      ["network-queue", { isNetwork: true }, "network or shared printer"],
      ["not-local", { isLocal: false }, "network or shared printer"],
      ["non-usb-port", { portName: "IP_192.0.2.1" }, "does not use a USB port"],
      ["hardware-id-unverified", { pnpDeviceId: "SWD\\PRINTENUM\\{queue}" }, "does not show"],
    ])("%s gets its own message", async (_problem, change, expected) => {
      const { scan } = await scanOf(row(change));
      expect(scan.kind === "none" && scan.notice).toContain(expected);
    });

    it("names duplicates: the same serial or the same device behind two queues", async () => {
      const second = row({ queueName: "Zebra Lobby", portName: "USB002", pnpDeviceId: "USBPRINT\\Zebra_TechnologiesZTCZD421\\7&OTHER&0&USB002" });
      const sameSerial = await scanOf(row(), second);
      expect(sameSerial.scan.kind === "none" && sameSerial.scan.notice).toContain("reports the serial number");
      const sameDevice = await scanOf(row(), row({ queueName: "Zebra Lobby", verifiedUsbSerial: "OTHER01" }));
      expect(sameDevice.scan.kind === "none" && sameDevice.scan.notice).toContain("points at the Zebra");
    });

    it("explains the queue closest to usable, and the cable before the name", () => {
      const report = parseWindowsPrinterProbe(response(
        row({ queueName: "Zebra Far", isNetwork: true, isLocal: false, portName: "IP_192.0.2.1", verifiedUsbSerial: null, serialEvidence: null }),
        row({ queueName: "Zebra #2", verifiedUsbSerial: null, serialEvidence: null, pnpDeviceId: "USBPRINT\\ZTCZD421\\7&2&0&USB002", portName: "USB002" }),
      ));
      expect(windowsUnusableZebraNotice(report)).toContain('Zebra on "Zebra #2"');
      expect(windowsUnusableZebraNotice(report)).toContain("cannot read the USB serial number");
    });

    it("keeps the plain 'no printer' answer when Windows has no Zebra queue at all", async () => {
      expect((await scanOf(row({ queueName: "Office Laser", driverName: "Generic", pnpDeviceId: null }))).scan).toEqual({ kind: "none" });
      expect((await scanOf()).scan).toEqual({ kind: "none" });
    });

    it("says nothing extra while a usable Zebra is offered", async () => {
      const { scan } = await scanOf(row(), row({ queueName: "Kids Zebra #1", portName: "USB002", pnpDeviceId: "USBPRINT\\ZTCZD421\\7&2&0&USB002", verifiedUsbSerial: "Z2" }));
      expect(scan).toMatchObject({ kind: "found", devices: [{ usbSerial: "ZD421A01" }] });
    });
  });

  it("requires explicit selection of multiple devices and does not silently replace a selected printer", async () => {
    const other = row({ queueName: "Other Zebra", portName: "USB002", pnpDeviceId: "USBPRINT\\Zebra_TechnologiesZTCZD621\\7&OTHER&0&USB002", verifiedUsbSerial: "Z621B02" });
    const service = createWindowsPrinterService(input(vi.fn().mockResolvedValue(ok(response(row(), other)))));
    const first = await service.scan(null);
    expect(first.scan).toMatchObject({ kind: "found", selectedId: null, queue: "disabled" });
    expect((await service.scan("windows-pnp:MISSING")).scan).toMatchObject({ selectedId: null, queue: "disabled" });
    const selected = await service.scan(`windows-pnp:${DEVICE.toUpperCase()}`);
    expect(selected).toMatchObject({ scan: { queue: "ready" }, queue: "Zebra ZD421" });
  });

  it("does not report ready for an offline/unknown queue or stale USB selection", async () => {
    for (const patch of [{ workOffline: true }, { printerStatus: null }, { detectedErrorState: 9 }]) {
      const service = createWindowsPrinterService(input(vi.fn().mockResolvedValue(ok(response(row(patch))))));
      expect((await service.scan(null)).scan).toMatchObject({ kind: "found", queue: "disabled" });
    }
    const service = createWindowsPrinterService(input(vi.fn().mockResolvedValue(ok(response(row())))));
    expect((await service.scan("windows-pnp:DISCONNECTED")).scan).toMatchObject({ selectedId: null, queue: "disabled" });
  });

  it("never mutates driver or queues: setup is a second read-only probe", async () => {
    const run = vi.fn().mockResolvedValue(ok(response(row())));
    const service = createWindowsPrinterService(input(run));
    const scanned = await service.scan(null);
    if (scanned.scan.kind !== "found") throw new Error("expected verified printer");
    expect(await service.setUp(scanned.scan.devices[0])).toEqual({ ok: true, queue: "Zebra ZD421" });
    expect(run.mock.calls.every((call) => call[1].includes("-File") && !call[1].includes("Print"))).toBe(true);
    run.mockResolvedValueOnce(ok(response()));
    expect(await service.setUp(scanned.scan.devices[0])).toEqual({ ok: false, reason: "failed", queue: null });
  });

  it("fails closed on PowerShell failure, bad probe JSON or wrong platform", async () => {
    for (const answer of [ok("bad-json"), { code: 1, stdout: "", stderr: "denied", timedOut: false }]) {
      const service = createWindowsPrinterService(input(vi.fn().mockResolvedValue(answer)));
      expect(await service.scan(null)).toEqual({ scan: { kind: "none" }, queue: null, listFailed: true, failureWarning: WINDOWS_SCAN_FAILED_WARNING });
    }
    const blocked = { code: 1, stdout: "", stderr: "    + FullyQualifiedErrorId : UnauthorizedAccess\r\n", timedOut: false };
    expect(await createWindowsPrinterService(input(vi.fn().mockResolvedValue(blocked))).scan(null))
      .toEqual({ scan: { kind: "none" }, queue: null, listFailed: true, failureWarning: POWERSHELL_BLOCKED_WARNING });
    const service = createWindowsPrinterService({ ...input(vi.fn()), platform: "darwin" });
    expect((await service.scan(null)).listFailed).toBe(true);
  });
});

describe("real ZD421 on the ZDesigner driver (2026-11-20)", () => {
  it("is eligible and offered with its USB serial and a ready queue", async () => {
    const zebra = row({
      queueName: "ZDesigner ZD421-203dpi ZPL", pnpDeviceId: null,
      usbPrintInstanceId: "USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB001",
      verifiedUsbSerial: "D8J253115309", serialEvidence: "usbprint-port", detectedErrorState: 0,
    });
    const pdf = row({ queueName: "Microsoft Print to PDF", driverName: "Microsoft Print To PDF", portName: "PORTPROMPT:", pnpDeviceId: null, usbPrintInstanceId: null, verifiedUsbSerial: null, serialEvidence: null, detectedErrorState: 0 });
    expect(eligibleWindowsZebras(parseWindowsPrinterProbe(response(pdf, zebra))).map((candidate) => candidate.verifiedUsbSerial)).toEqual(["D8J253115309"]);
    const key = "windows-pnp:USBPRINT\\ZEBRA_TECHNOLOGIES_ZTC_ZD421-203DPI_ZPL\\6&1DBA03D&0&USB001";
    expect(await createWindowsPrinterService(input(vi.fn().mockResolvedValue(ok(response(pdf, zebra))))).scan(null)).toEqual({
      scan: { kind: "found", devices: [{ id: key, deviceUri: key, usbSerial: "D8J253115309", model: "ZDesigner ZD421-203dpi ZPL" }], selectedId: key, queue: "ready" },
      queue: "ZDesigner ZD421-203dpi ZPL", listFailed: false,
    });
  });
});
