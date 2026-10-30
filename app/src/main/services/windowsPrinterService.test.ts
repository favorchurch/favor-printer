import { describe, expect, it, vi } from "vitest";

import { createWindowsPrinterService } from "./windowsPrinterService";
import type { CommandRunner } from "./command";

const DEVICE = "USBPRINT\\Zebra_TechnologiesZTCZD421\\7&ABCDEF&0&USB001";
const row = (change: Record<string, unknown> = {}) => ({
  queueName: "Zebra ZD421", driverName: "ZDesigner ZD421-203dpi ZPL", portName: "USB001",
  pnpDeviceId: DEVICE, verifiedUsbSerial: "ZD421A01", serialEvidence: "unique-usb-parent",
  isLocal: true, isNetwork: false, workOffline: false, printerStatus: 3, detectedErrorState: 2,
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
      expect((await service.scan(null)).scan).toEqual({ kind: "none" });
    }
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
      expect(await service.scan(null)).toEqual({ scan: { kind: "none" }, queue: null, listFailed: true });
    }
    const service = createWindowsPrinterService({ ...input(vi.fn()), platform: "darwin" });
    expect((await service.scan(null)).listFailed).toBe(true);
  });
});
