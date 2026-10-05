import { describe, expect, it } from "vitest";

import type { PrinterDevice } from "../../shared";
import { BINARIES, type CommandResult } from "./command";
import { classifyLpadminFailure, createPrinterService, ZEBRA_PPD } from "./printerService";
import { expectArgvOnly, fail, ok, scriptedRunner } from "./testing/fakes";

const URI_A = "usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J190800123";
const URI_B = "usb://Zebra%20Technologies/ZTC%20ZD621-300dpi%20ZPL?serial=D2J190800999";

const DEVICE_A: PrinterDevice = { id: URI_A, deviceUri: URI_A, usbSerial: "D2J190800123", model: "ZD421-203dpi ZPL" };

type Cups = {
  lpinfo?: CommandResult;
  devices?: CommandResult;
  printers?: CommandResult;
  lpadmin?: CommandResult;
};

const NO_DESTINATIONS = fail(1, "lpstat: No destinations added.");

/** A fake CUPS: each binary answers from `cups`. Unset lpstat output means no queues. */
function cups(responses: Cups = {}) {
  return scriptedRunner((file, args) => {
    if (file === BINARIES.lpinfo) return responses.lpinfo ?? ok("");
    if (file === BINARIES.lpadmin) return responses.lpadmin ?? ok("");
    if (file === BINARIES.lpstat && args[0] === "-v") return responses.devices ?? NO_DESTINATIONS;
    if (file === BINARIES.lpstat && args[0] === "-p") return responses.printers ?? NO_DESTINATIONS;
    throw new Error(`unexpected command ${file} ${args.join(" ")}`);
  });
}

const lpinfoWith = (...uris: string[]) => ok(["network ipp", ...uris.map((uri) => `direct ${uri}`)].join("\n"));

describe("scan", () => {
  it("runs lpinfo for USB devices only, as argv", async () => {
    const { run, calls } = cups({ lpinfo: lpinfoWith() });
    await createPrinterService({ run }).scan(null);
    expect(calls[0]).toEqual({ file: BINARIES.lpinfo, args: ["--include-schemes", "usb", "-v"] });
    expectArgvOnly(calls);
  });

  it("reports no device", async () => {
    const { run, calls } = cups({ lpinfo: lpinfoWith() });
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome).toEqual({ scan: { kind: "none" }, queue: null, listFailed: false });
    expect(calls.filter((call) => call.file === BINARIES.lpstat)).toEqual([]);
  });

  it("reports that listing failed, which is not the same as no printer", async () => {
    const { run } = cups({ lpinfo: fail(1, "lpinfo: Forbidden") });
    expect(await createPrinterService({ run }).scan(null)).toEqual({
      scan: { kind: "none" },
      queue: null,
      listFailed: true,
    });
  });

  it("selects the only Zebra and reuses its queue", async () => {
    const { run } = cups({
      lpinfo: lpinfoWith(URI_A),
      devices: ok(`device for My_Zebra: ${URI_A}`),
      printers: ok("printer My_Zebra is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT"),
    });
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome).toEqual({
      scan: { kind: "found", devices: [DEVICE_A], selectedId: URI_A, queue: "ready" },
      queue: "My_Zebra",
      listFailed: false,
    });
  });

  it("reports a missing queue when CUPS has no destinations", async () => {
    const { run } = cups({ lpinfo: lpinfoWith(URI_A) });
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome.scan).toMatchObject({ kind: "found", selectedId: URI_A, queue: "missing" });
    expect(outcome.queue).toBeNull();
  });

  it("reports a disabled queue", async () => {
    const { run } = cups({
      lpinfo: lpinfoWith(URI_A),
      devices: ok(`device for My_Zebra: ${URI_A}`),
      printers: ok("printer My_Zebra disabled since Sat 04 Oct 2026 09:00:00 PHT -\n\treason unknown"),
    });
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome.scan).toMatchObject({ queue: "disabled" });
    expect(outcome.queue).toBe("My_Zebra");
  });

  it("lists several Zebras and waits for a choice", async () => {
    const { run, calls } = cups({ lpinfo: lpinfoWith(URI_A, URI_B) });
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome.scan).toMatchObject({ kind: "found", selectedId: null, queue: "missing" });
    if (outcome.scan.kind !== "found") throw new Error("expected found");
    expect(outcome.scan.devices.map((device) => device.id)).toEqual([URI_A, URI_B]);
    expect(outcome.queue).toBeNull();
    expect(calls.filter((call) => call.file === BINARIES.lpstat)).toEqual([]);
  });

  it("keeps the chosen Zebra among several and looks up its queue", async () => {
    const { run } = cups({
      lpinfo: lpinfoWith(URI_A, URI_B),
      devices: ok(`device for Second: ${URI_B}`),
      printers: ok("printer Second is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT"),
    });
    const outcome = await createPrinterService({ run }).scan(URI_B);
    expect(outcome.scan).toMatchObject({ selectedId: URI_B, queue: "ready" });
    expect(outcome.queue).toBe("Second");
  });

  it("drops a choice that is no longer plugged in", async () => {
    const { run } = cups({ lpinfo: lpinfoWith(URI_A, URI_B) });
    const outcome = await createPrinterService({ run }).scan("usb://Zebra/Gone?serial=OLD");
    expect(outcome.scan).toMatchObject({ selectedId: null });
  });

  it("does not match a queue for a different Zebra", async () => {
    const { run } = cups({
      lpinfo: lpinfoWith(URI_A),
      devices: ok(`device for Other: ${URI_B}`),
      printers: ok("printer Other is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT"),
    });
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome.scan).toMatchObject({ queue: "missing" });
  });
});

describe("lpstat failures are never ready", () => {
  const listed = { lpinfo: lpinfoWith(URI_A) };
  const queueLines = {
    devices: ok(`device for My_Zebra: ${URI_A}`),
    printers: ok("printer My_Zebra is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT"),
  };

  it.each([
    ["lpstat -v exits non-zero", { ...listed, ...queueLines, devices: fail(1, "lpstat: Bad file descriptor") }],
    ["lpstat -p exits non-zero", { ...listed, ...queueLines, printers: fail(1, "lpstat: Bad file descriptor") }],
    ["lpstat -v cannot start", { ...listed, ...queueLines, devices: fail(null, "spawn ENOENT") }],
    ["lpstat -p times out", { ...listed, ...queueLines, printers: fail(null, "", true) }],
    ["lpstat exits non-zero but still prints queue lines", { ...listed, ...queueLines, printers: { ...queueLines.printers, code: 1 } }],
  ])("scan: %s", async (_name, responses) => {
    const { run } = cups(responses);
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome.listFailed).toBe(true);
    expect(outcome.queue).toBeNull();
    expect(outcome.scan).toMatchObject({ kind: "found", selectedId: URI_A });
    if (outcome.scan.kind !== "found") throw new Error("expected found");
    expect(outcome.scan.queue).not.toBe("ready");
  });

  it("scan: a queue missing from lpstat -p is not ready", async () => {
    const { run } = cups({ ...listed, devices: queueLines.devices, printers: ok("printer Another is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT") });
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome.listFailed).toBe(false);
    if (outcome.scan.kind !== "found") throw new Error("expected found");
    expect(outcome.scan.queue).not.toBe("ready");
  });

  it("scan: the no-destinations message is an empty list, not a failure", async () => {
    const { run } = cups(listed);
    const outcome = await createPrinterService({ run }).scan(null);
    expect(outcome.listFailed).toBe(false);
    expect(outcome.scan).toMatchObject({ queue: "missing" });
  });

  it("setUp: reports failure instead of guessing, and runs no lpadmin", async () => {
    const { run, calls } = cups({ ...queueLines, devices: fail(1, "lpstat: Bad file descriptor") });
    expect(await createPrinterService({ run }).setUp(DEVICE_A)).toEqual({ ok: false, reason: "failed", queue: null });
    expect(calls.some((call) => call.file === BINARIES.lpadmin)).toBe(false);
  });

  it("setUp: a queue missing from lpstat -p is not reused as ready", async () => {
    const { run, calls } = cups({ devices: queueLines.devices, printers: ok("printer Another is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT") });
    const outcome = await createPrinterService({ run }).setUp(DEVICE_A);
    expect(outcome).toEqual({ ok: true, queue: "My_Zebra" });
    // It was switched on, not assumed ready.
    expect(calls.filter((call) => call.file === BINARIES.lpadmin)).toEqual([
      { file: BINARIES.lpadmin, args: ["-p", "My_Zebra", "-E"] },
    ]);
  });
});

describe("setUp", () => {
  it("reuses an enabled queue bound to the device and runs no lpadmin", async () => {
    const { run, calls } = cups({
      devices: ok(`device for My_Zebra: ${URI_A}`),
      printers: ok("printer My_Zebra is idle.  enabled since Sat 04 Oct 2026 10:00:00 PHT"),
    });
    expect(await createPrinterService({ run }).setUp(DEVICE_A)).toEqual({ ok: true, queue: "My_Zebra" });
    expect(calls.some((call) => call.file === BINARIES.lpadmin)).toBe(false);
  });

  it("creates a queue with lpadmin argv when none exists", async () => {
    const { run, calls } = cups();
    expect(await createPrinterService({ run }).setUp(DEVICE_A)).toEqual({ ok: true, queue: "Favor_D2J190800123" });
    const lpadmin = calls.filter((call) => call.file === BINARIES.lpadmin);
    expect(lpadmin).toEqual([
      { file: BINARIES.lpadmin, args: ["-p", "Favor_D2J190800123", "-E", "-v", URI_A, "-m", ZEBRA_PPD] },
    ]);
    expectArgvOnly(calls);
  });

  it("does not create a second queue for a Zebra whose queue is disabled: it turns that queue back on", async () => {
    const { run, calls } = cups({
      devices: ok(`device for My_Zebra: ${URI_A}`),
      printers: ok("printer My_Zebra disabled since Sat 04 Oct 2026 09:00:00 PHT -"),
    });
    expect(await createPrinterService({ run }).setUp(DEVICE_A)).toEqual({ ok: true, queue: "My_Zebra" });
    expect(calls.filter((call) => call.file === BINARIES.lpadmin)).toEqual([
      { file: BINARIES.lpadmin, args: ["-p", "My_Zebra", "-E"] },
    ]);
  });

  it.each(["lpadmin: Unauthorized", "lpadmin: Forbidden", "lpadmin: Operation not permitted", "lpadmin: Permission denied"])(
    "returns the guided fallback reason when macOS refuses (%s)",
    async (stderr) => {
      const { run } = cups({ lpadmin: fail(1, stderr) });
      expect(await createPrinterService({ run }).setUp(DEVICE_A)).toEqual({ ok: false, reason: "permission", queue: null });
    },
  );

  it("returns a plain failure for other lpadmin errors", async () => {
    const { run } = cups({ lpadmin: fail(1, "lpadmin: Bad device-uri") });
    expect(await createPrinterService({ run }).setUp(DEVICE_A)).toEqual({ ok: false, reason: "failed", queue: null });
  });

  it("returns a plain failure when lpadmin cannot start or times out", async () => {
    for (const lpadmin of [fail(null, "spawn ENOENT"), fail(null, "", true)]) {
      const { run } = cups({ lpadmin });
      expect(await createPrinterService({ run }).setUp(DEVICE_A)).toMatchObject({ ok: false, reason: "failed" });
    }
  });
});

describe("classifyLpadminFailure", () => {
  it("does not read a timeout as a refusal even when the text says so", () => {
    expect(classifyLpadminFailure(fail(null, "Unauthorized", true))).toBe("failed");
  });
});
