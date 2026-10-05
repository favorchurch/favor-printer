import { describe, expect, it, vi } from "vitest";

import { parseParentMessage } from "../../../../vendor/relay/embeddedProtocol";
import {
  CREDENTIALS,
  createControllerHarness,
  DEVICE,
  foundPrinter,
  LIST_FAILED,
  NO_PRINTER,
  type ControllerHarness,
  type HarnessOptions,
} from "./testing/controllerHarness";
import type { ScanOutcome } from "../services";
import { LEGACY_FAILED_DETAIL } from "./controller";
import { relayStatus } from "./testing/fakeChild";

const ENROLLED: HarnessOptions = {
  credentials: CREDENTIALS,
  scan: foundPrinter(),
  prefs: { openAtLogin: true, setupComplete: true },
};

async function started(options: HarnessOptions = ENROLLED) {
  const h = createControllerHarness(options);
  await h.controller.initialize();
  return h;
}

/** Waits until the supervisor has posted `stop` to the current child, then lets it finish. */
async function finishStop(h: ControllerHarness) {
  await vi.waitFor(() => expect(h.forks.last().types()).toContain("stop"));
  h.forks.last().emitMessage({ type: "stopped" });
  h.forks.last().emitExit(0);
}

describe("first run and login item", () => {
  it("turns open at login on by default and remembers it", async () => {
    const h = await started({ scan: NO_PRINTER });
    expect(h.applyOpenAtLogin).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.prefsFs.saved()).toMatchObject({ openAtLogin: true });
    expect(h.controller.snapshot().openAtLogin).toBe(true);
  });

  it("does not override a saved choice on later launches", async () => {
    const h = await started({ scan: NO_PRINTER, prefs: { openAtLogin: false } });
    expect(h.applyOpenAtLogin).not.toHaveBeenCalled();
    expect(h.controller.snapshot().openAtLogin).toBe(false);
  });

  it("persists the toggle and applies it", async () => {
    const h = await started();
    await h.controller.setOpenAtLogin(false);
    expect(h.applyOpenAtLogin).toHaveBeenLastCalledWith(false);
    expect(h.prefsFs.saved()).toMatchObject({ openAtLogin: false });
    expect(h.controller.snapshot().openAtLogin).toBe(false);

    await h.controller.setOpenAtLogin(true);
    expect(h.prefsFs.saved()).toMatchObject({ openAtLogin: true });
  });
});

describe("startup", () => {
  it("starts at the welcome step and does not run a relay before enrollment", async () => {
    const h = await started({ scan: foundPrinter() });
    const snapshot = h.controller.snapshot();
    expect(snapshot.setupStep).toBe("welcome");
    expect(snapshot.enrolled).toBe(false);
    expect(h.forks.children).toHaveLength(0);
  });

  it("starts the relay for an enrolled laptop and shows no setup step", async () => {
    const h = await started();
    expect(h.forks.children).toHaveLength(1);
    expect(h.controller.snapshot()).toMatchObject({ enrolled: true, setupStep: null });

    const start = parseParentMessage(h.forks.last().messages[0]);
    expect(start).toMatchObject({
      type: "start",
      options: { relayId: "relay-1", transport: { kind: "cups", queue: "Favor_S1" }, printerAttached: true },
    });
  });

  it("resumes setup for an enrolled laptop that never finished it", async () => {
    const h = await started({ ...ENROLLED, prefs: { openAtLogin: true, setupComplete: false } });
    expect(h.controller.snapshot().setupStep).toBe("connected");
  });

  it("starts the relay with the printer unplugged, using the queue it remembered", async () => {
    const h = await started({ credentials: CREDENTIALS, scan: NO_PRINTER, prefs: { openAtLogin: true, setupComplete: true, queue: "Favor_S1" } });
    expect(h.forks.children).toHaveLength(1);
    expect(h.forks.last().messages[0]).toMatchObject({ options: { transport: { queue: "Favor_S1" }, printerAttached: false } });
    expect(h.controller.snapshot().status.headline).toBe("No printer found");
  });

  describe("a remembered queue is not trusted while the printer is attached", () => {
    const SAVED = { openAtLogin: true, setupComplete: true, queue: "Favor_S1" };
    const TWO: ScanOutcome = {
      scan: { kind: "found", devices: [DEVICE, { ...DEVICE, id: "usb://other", deviceUri: "usb://other", usbSerial: "S2" }], selectedId: null, queue: "missing" },
      queue: null,
      listFailed: false,
    };

    it.each(["missing", "disabled"] as const)("does not start the relay when the attached printer's queue is %s", async (queue) => {
      const h = await started({ credentials: CREDENTIALS, scan: foundPrinter(queue), prefs: SAVED });
      expect(h.forks.children).toHaveLength(0);
      expect(h.controller.snapshot().status.color).toBe("amber");
      expect(h.supervisorPhase()).toBe("blocked");
    });

    it("forgets the stale queue name", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: foundPrinter("missing"), prefs: SAVED });
      expect(h.prefsFs.saved()?.queue ?? null).toBeNull();
    });

    it("does not start while several printers are attached and none is chosen", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: TWO, prefs: SAVED });
      expect(h.forks.children).toHaveLength(0);
    });

    it("starts once set up produces a ready queue, with that queue and not the old name", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: foundPrinter("missing"), prefs: SAVED });
      h.state.scan = foundPrinter("ready", "Favor_New");
      await expect(h.controller.setUpPrinter()).resolves.toEqual({ ok: true });
      expect(h.forks.children).toHaveLength(1);
      expect(h.forks.last().messages[0]).toMatchObject({ options: { transport: { queue: "Favor_New" } } });
      expect(h.prefsFs.saved()).toMatchObject({ queue: "Favor_New" });
    });

    it("still uses the remembered queue when the printer is absent", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: NO_PRINTER, prefs: SAVED });
      expect(h.forks.last().messages[0]).toMatchObject({ options: { transport: { queue: "Favor_S1" }, printerAttached: false } });
    });

    it("does not use it when the listing failed, because the printer may be attached", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: LIST_FAILED, prefs: SAVED });
      expect(h.forks.children).toHaveLength(0);
      // The next listing shows the printer is really absent: now the remembered queue is safe.
      h.state.scan = NO_PRINTER;
      await h.controller.scanPrinters();
      expect(h.forks.children).toHaveLength(1);
      expect(h.forks.last().messages[0]).toMatchObject({ options: { transport: { queue: "Favor_S1" } } });
    });

    it("does not let a scan that lands during quit start the relay again", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: NO_PRINTER, prefs: { openAtLogin: true, setupComplete: true } });
      expect(h.forks.children).toHaveLength(0);
      const shutdown = h.controller.shutdown();
      h.state.scan = foundPrinter();
      await h.controller.scanPrinters();
      await shutdown;
      expect(h.forks.children).toHaveLength(0);
    });
  });

  it("does not start while the legacy agent is loaded", async () => {
    const h = await started({ ...ENROLLED, legacyLoaded: true });
    expect(h.forks.children).toHaveLength(0);
    expect(h.controller.snapshot()).toMatchObject({ legacyRelayLoaded: true });
    expect(h.controller.snapshot().status.headline).toBe("The old print relay is still running");
  });

  it("starts after the legacy agent is migrated", async () => {
    const h = await started({ ...ENROLLED, legacyLoaded: true });
    await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: true });
    expect(h.forks.children).toHaveLength(1);
    expect(h.controller.snapshot().legacyRelayLoaded).toBe(false);
  });

  it("stays red and does not start after a revocation, even with a saved token", async () => {
    const h = await started({ ...ENROLLED, prefs: { openAtLogin: true, setupComplete: true, revoked: true } });
    expect(h.forks.children).toHaveLength(0);
    const snapshot = h.controller.snapshot();
    expect(snapshot.status.color).toBe("red");
    expect(snapshot.enrolled).toBe(false);
  });
});

describe("legacy relay migration", () => {
  const LEGACY: HarnessOptions = { ...ENROLLED, legacyLoaded: true };

  it("offers the move but runs nothing by itself", async () => {
    const h = await started(LEGACY);
    await h.controller.refresh();
    await h.controller.scanPrinters();

    expect(h.legacy.migrate).not.toHaveBeenCalled();
    expect(h.forks.children).toHaveLength(0);
    const snapshot = h.controller.snapshot();
    expect(snapshot.legacyRelayLoaded).toBe(true);
    expect(snapshot.status).toMatchObject({
      color: "amber",
      headline: "The old print relay is still running",
      detail: "Move to Favor Printer to start printing.",
    });
  });

  it("holds setup at the welcome step until the old relay is moved", async () => {
    const h = createControllerHarness({ scan: foundPrinter(), legacyLoaded: true });
    await h.controller.initialize();
    expect((await h.controller.advance()).setupStep).toBe("welcome");
    expect((await h.controller.advance()).setupStep).toBe("welcome");

    await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: true });
    expect((await h.controller.advance()).setupStep).toBe("printer");
  });

  describe("on success", () => {
    it("checks that the label is gone before the relay starts", async () => {
      const h = await started(LEGACY);
      const before = h.events.length;
      await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: true });

      // launchd is asked to move it, then asked again whether it is gone, and only then does the relay start.
      expect(h.events.slice(before)).toEqual(["migrate", "detect", "canStart", "fork"]);
      expect(h.forks.children).toHaveLength(1);
      expect(h.controller.snapshot().legacyRelayLoaded).toBe(false);
      expect(h.controller.snapshot().status.headline).not.toBe("The old print relay is still running");
    });

    it("does not start a relay for a laptop that is not enrolled yet", async () => {
      const h = createControllerHarness({ scan: foundPrinter(), legacyLoaded: true });
      await h.controller.initialize();
      await h.controller.migrateLegacyRelay();
      expect(h.forks.children).toHaveLength(0);
      expect(h.controller.snapshot().legacyRelayLoaded).toBe(false);
    });

    it("does not start a relay for a revoked laptop", async () => {
      const h = await started({ ...LEGACY, prefs: { openAtLogin: true, setupComplete: true, revoked: true } });
      await h.controller.migrateLegacyRelay();
      expect(h.forks.children).toHaveLength(0);
    });

    it("runs nothing when there is no old relay to move", async () => {
      const h = await started();
      await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: true });
      expect(h.legacy.migrate).not.toHaveBeenCalled();
    });

    it("answers a double click with one move", async () => {
      const h = await started(LEGACY);
      const first = h.controller.migrateLegacyRelay();
      const second = h.controller.migrateLegacyRelay();
      expect(second).toBe(first);
      await first;
      expect(h.legacy.migrate).toHaveBeenCalledTimes(1);
      expect(h.forks.children).toHaveLength(1);
    });
  });

  describe("fails closed", () => {
    it.each(["bootout_failed", "disable_failed"] as const)("keeps the relay blocked and says so after %s", async (reason) => {
      const h = await started(LEGACY);
      h.migrateMode.current = reason;
      await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: false, reason });

      expect(h.forks.children).toHaveLength(0);
      const snapshot = h.controller.snapshot();
      expect(snapshot.legacyRelayLoaded).toBe(true);
      expect(snapshot.status).toMatchObject({ color: "amber", headline: "The old print relay is still running", detail: LEGACY_FAILED_DETAIL });
    });

    it("treats a zero exit with the label still loaded as a failure", async () => {
      const h = await started(LEGACY);
      h.migrateMode.current = "still_loaded";
      await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: false, reason: "bootout_failed" });
      expect(h.forks.children).toHaveLength(0);
      expect(h.controller.snapshot().legacyRelayLoaded).toBe(true);
      expect(h.controller.snapshot().status.detail).toBe(LEGACY_FAILED_DETAIL);
    });

    it("treats an unexpected error as a failure and never logs its text", async () => {
      const h = await started(LEGACY);
      h.migrateMode.current = "throws";
      await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: false, reason: "bootout_failed" });
      expect(h.forks.children).toHaveLength(0);
      expect(h.controller.snapshot().legacyRelayLoaded).toBe(true);
      expect(h.logLines.join("\n")).not.toContain("exploded");
    });

    it("stays blocked on later scans and refreshes, even when launchd no longer lists the label", async () => {
      const h = await started(LEGACY);
      h.migrateMode.current = "disable_failed";
      await h.controller.migrateLegacyRelay();
      // The bootout did work, but the disable did not: it could come back at login.
      h.setLegacyLoaded(false);

      await h.controller.refresh();
      await h.controller.scanPrinters();
      expect(h.forks.children).toHaveLength(0);
      expect(h.controller.snapshot().legacyRelayLoaded).toBe(true);
      expect(h.controller.snapshot().status.detail).toBe(LEGACY_FAILED_DETAIL);
    });

    it("stays blocked after a refresh until a move succeeds", async () => {
      const h = await started(LEGACY);
      h.migrateMode.current = "bootout_failed";
      await h.controller.migrateLegacyRelay();
      await h.controller.refresh();
      expect(h.forks.children).toHaveLength(0);
    });

    it("recovers when a later try succeeds: starts the relay and clears the error", async () => {
      const h = await started(LEGACY);
      h.migrateMode.current = "bootout_failed";
      await h.controller.migrateLegacyRelay();
      expect(h.forks.children).toHaveLength(0);

      h.migrateMode.current = "ok";
      await expect(h.controller.migrateLegacyRelay()).resolves.toEqual({ ok: true });
      expect(h.forks.children).toHaveLength(1);
      const snapshot = h.controller.snapshot();
      expect(snapshot.legacyRelayLoaded).toBe(false);
      expect(snapshot.status.detail).not.toBe(LEGACY_FAILED_DETAIL);
    });

    it("keeps setup at the welcome step after a failure", async () => {
      const h = createControllerHarness({ scan: foundPrinter(), legacyLoaded: true });
      await h.controller.initialize();
      h.migrateMode.current = "bootout_failed";
      await h.controller.migrateLegacyRelay();
      expect((await h.controller.advance()).setupStep).toBe("welcome");
    });
  });
});

describe("printer attach and detach", () => {
  it("tells the relay when the printer is unplugged and plugged back in", async () => {
    const h = await started();
    h.state.scan = NO_PRINTER;
    await h.controller.scanPrinters();
    h.state.scan = foundPrinter();
    await h.controller.scanPrinters();

    const forwarded = h.forks.last().messages.slice(1);
    expect(forwarded).toEqual([
      { type: "printerAttached", attached: false },
      { type: "printerAttached", attached: true },
    ]);
    expect(forwarded.map(parseParentMessage)).toEqual(forwarded);
  });

  it("does not send the same state twice", async () => {
    const h = await started();
    await h.controller.scanPrinters();
    await h.controller.scanPrinters();
    expect(h.forks.last().types()).toEqual(["start"]);
  });

  it("does not treat a failed listing as an unplug", async () => {
    const h = await started();
    h.state.scan = LIST_FAILED;
    await h.controller.scanPrinters();
    expect(h.forks.last().types()).toEqual(["start"]);
    expect(h.controller.snapshot().status.headline).not.toBe("No printer found");
  });

  it("scans again on a timer", async () => {
    const h = await started();
    const before = vi.mocked(h.printers.scan).mock.calls.length;
    h.timers.fire("interval");
    await vi.waitFor(() => expect(vi.mocked(h.printers.scan).mock.calls.length).toBe(before + 1));
  });

  it("keeps the power hold in step with the printer and the last job", async () => {
    const h = await started();
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ lastJobAt: "2026-10-04T01:00:00.000Z" }) });
    expect(h.power.update).toHaveBeenLastCalledWith({ printerAttached: true, lastJobAt: "2026-10-04T01:00:00.000Z" });

    h.state.scan = NO_PRINTER;
    await h.controller.scanPrinters();
    expect(h.power.update).toHaveBeenLastCalledWith({ printerAttached: false, lastJobAt: "2026-10-04T01:00:00.000Z" });
  });
});

describe("the running relay follows the selected printer's queue", () => {
  const SAVED = { openAtLogin: true, setupComplete: true, queue: "Favor_S1" };

  /** Starts a scan and finishes the relay's stop while it waits, as a real relay would. */
  async function scanThroughStop(h: ControllerHarness) {
    const scan = h.controller.scanPrinters();
    await vi.waitFor(() => expect(h.forks.last().types()).toContain("stop"));
    h.forks.last().emitMessage({ type: "stopped" });
    h.forks.last().emitExit(0);
    await scan;
  }

  describe("offline start, then the printer appears with no queue", () => {
    async function offlineThenAttached(queue: "missing" | "disabled" = "missing") {
      const h = await started({ credentials: CREDENTIALS, scan: NO_PRINTER, prefs: SAVED });
      // Started offline on the remembered queue.
      expect(h.forks.children).toHaveLength(1);
      expect(h.forks.last().messages[0]).toMatchObject({ options: { transport: { queue: "Favor_S1" }, printerAttached: false } });

      h.state.scan = foundPrinter(queue);
      await scanThroughStop(h);
      return h;
    }

    it.each(["missing", "disabled"] as const)("stops the relay when the queue is %s, so it cannot claim jobs", async (queue) => {
      const h = await offlineThenAttached(queue);
      expect(h.forks.last().types()).toEqual(["start", "printerAttached", "stop"]);
      expect(h.forks.last().messages[1]).toEqual({ type: "printerAttached", attached: true });
      expect(h.forks.children).toHaveLength(1);
      expect(h.controller.snapshot().status.headline).toBe(queue === "missing" ? "Printer needs setting up" : "Printer is turned off");
    });

    it("forgets the stale queue name", async () => {
      const h = await offlineThenAttached();
      expect(h.prefsFs.saved()?.queue ?? null).toBeNull();
    });

    it("does not start again on later scans while there is still no queue", async () => {
      const h = await offlineThenAttached();
      await h.controller.scanPrinters();
      await h.controller.scanPrinters();
      expect(h.forks.children).toHaveLength(1);
    });

    it("starts again with the new queue once setup produces one", async () => {
      const h = await offlineThenAttached();
      h.state.scan = foundPrinter("ready", "Favor_New");
      await expect(h.controller.setUpPrinter()).resolves.toEqual({ ok: true });

      expect(h.forks.children).toHaveLength(2);
      expect(h.forks.last().messages[0]).toMatchObject({
        type: "start",
        options: { transport: { queue: "Favor_New" }, printerAttached: true },
      });
      expect(h.prefsFs.saved()).toMatchObject({ queue: "Favor_New" });
    });

    it("does not touch the relay when the printer is merely absent again", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: NO_PRINTER, prefs: SAVED });
      await h.controller.scanPrinters();
      expect(h.forks.last().types()).toEqual(["start"]);
    });
  });

  describe("queue replacement", () => {
    it("restarts the relay on the new queue", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: foundPrinter("ready", "Favor_S1"), prefs: SAVED });
      expect(h.forks.last().messages[0]).toMatchObject({ options: { transport: { queue: "Favor_S1" } } });

      h.state.scan = foundPrinter("ready", "Favor_S2");
      await scanThroughStop(h);
      await vi.waitFor(() => expect(h.forks.children).toHaveLength(2));

      expect(h.forks.children[0].types()).toContain("stop");
      expect(h.forks.last().messages[0]).toMatchObject({ type: "start", options: { transport: { queue: "Favor_S2" } } });
      expect(h.prefsFs.saved()).toMatchObject({ queue: "Favor_S2" });
    });

    it("restarts a relay that was started offline when the printer shows up on a different queue", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: NO_PRINTER, prefs: SAVED });
      h.state.scan = foundPrinter("ready", "Favor_Other");
      await scanThroughStop(h);
      await vi.waitFor(() => expect(h.forks.children).toHaveLength(2));
      expect(h.forks.last().messages[0]).toMatchObject({ options: { transport: { queue: "Favor_Other" }, printerAttached: true } });
    });

    it("leaves the relay alone when the queue is the same", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: foundPrinter("ready", "Favor_S1"), prefs: SAVED });
      await h.controller.scanPrinters();
      await h.controller.scanPrinters();
      expect(h.forks.children).toHaveLength(1);
      expect(h.forks.last().types()).toEqual(["start"]);
    });

    it("leaves the relay alone when the listing failed", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: foundPrinter("ready", "Favor_S1"), prefs: SAVED });
      h.state.scan = LIST_FAILED;
      await h.controller.scanPrinters();
      expect(h.forks.last().types()).toEqual(["start"]);
    });

    it("does not restart the relay during quit", async () => {
      const h = await started({ credentials: CREDENTIALS, scan: foundPrinter("ready", "Favor_S1"), prefs: SAVED });
      const shutdown = h.controller.shutdown();
      h.state.scan = foundPrinter("ready", "Favor_S2");
      const scan = h.controller.scanPrinters();
      h.forks.last().emitMessage({ type: "stopped" });
      h.forks.last().emitExit(0);
      await shutdown;
      await scan;
      expect(h.forks.children).toHaveLength(1);
    });
  });
});

describe("printer selection and set up", () => {
  it("selects only a printer it has seen", async () => {
    const h = await started({ scan: foundPrinter("missing") });
    await h.controller.selectPrinter("usb://unknown");
    expect(h.prefsFs.saved()).not.toHaveProperty("selectedPrinterId", "usb://unknown");
    await h.controller.selectPrinter(DEVICE.id);
    expect(h.prefsFs.saved()).toMatchObject({ selectedPrinterId: DEVICE.id });
  });

  it("fails to set up when no printer is selected", async () => {
    const h = await started({ scan: NO_PRINTER });
    await expect(h.controller.setUpPrinter()).resolves.toEqual({ ok: false, reason: "failed" });
    expect(h.printers.setUp).not.toHaveBeenCalled();
  });

  it("sets up the selected printer and scans again", async () => {
    const h = await started({ scan: foundPrinter("missing") });
    h.state.scan = foundPrinter("ready");
    await expect(h.controller.setUpPrinter()).resolves.toEqual({ ok: true });
    expect(h.printers.setUp).toHaveBeenCalledWith(DEVICE);
    expect(h.controller.snapshot().printer).toMatchObject({ queue: "ready" });
  });

  it("passes a permission refusal through so the window can guide the volunteer", async () => {
    const h = await started({ scan: foundPrinter("missing"), setUp: async () => ({ ok: false, reason: "permission", queue: null }) });
    await expect(h.controller.setUpPrinter()).resolves.toEqual({ ok: false, reason: "permission" });
  });

  it("starts a relay that was waiting for a queue", async () => {
    const h = await started({ credentials: CREDENTIALS, scan: NO_PRINTER, prefs: { openAtLogin: true, setupComplete: true } });
    expect(h.forks.children).toHaveLength(0);
    h.state.scan = foundPrinter();
    await h.controller.scanPrinters();
    expect(h.forks.children).toHaveLength(1);
  });

  it("opens the printer settings through the UI hook", async () => {
    const h = await started();
    await h.controller.openPrinterSettings();
    expect(h.ui.openPrinterSettings).toHaveBeenCalled();
  });
});

describe("enroll", () => {
  const setup = () => started({ scan: foundPrinter(), prefs: { openAtLogin: true } });

  it("sends the code with the printer's serial and keeps the token only in the secret store", async () => {
    const h = await setup();
    await expect(h.controller.enroll("123456")).resolves.toEqual({ ok: true });

    expect(h.enroll).toHaveBeenCalledWith({
      apiUrl: "https://rsvp.favor.church",
      code: "123456",
      usbSerial: "S1",
      appVersion: "0.1.0",
      osVersion: "macOS 15",
    });
    expect(h.secrets.save).toHaveBeenCalledWith({ relayId: "relay-1", token: "tok-secret-value" });
    expect(JSON.stringify(h.prefsFs.saved())).not.toContain("tok-secret-value");
    expect(JSON.stringify(h.controller.snapshot())).not.toContain("tok-secret-value");
    expect(h.logLines.join("\n")).not.toContain("tok-secret-value");

    expect(h.prefsFs.saved()).toMatchObject({ label: "Front desk", revoked: false });
    expect(h.controller.snapshot()).toMatchObject({ enrolled: true, setupStep: "connected", label: "Front desk" });
  });

  it("starts the relay once enrolled", async () => {
    const h = await setup();
    await h.controller.enroll("123456");
    expect(h.forks.children).toHaveLength(1);
    expect(h.forks.last().messages[0]).toMatchObject({ type: "start", options: { relayId: "relay-1", token: "tok-secret-value" } });
  });

  it.each(["", "12345", "1234567", "12 456", "abcdef", "١٢٣٤٥٦"])("does not contact the cloud for %j", async (code) => {
    const h = await setup();
    await expect(h.controller.enroll(code)).resolves.toEqual({ ok: false, reason: "invalid_code" });
    expect(h.enroll).not.toHaveBeenCalled();
  });

  it.each(["invalid_code", "throttled", "disabled", "unreachable", "invalid_request"] as const)(
    "reports %s and saves nothing",
    async (reason) => {
      const h = createControllerHarness({ scan: foundPrinter(), enroll: async () => ({ ok: false, reason }) });
      await h.controller.initialize();
      await expect(h.controller.enroll("123456")).resolves.toEqual({ ok: false, reason });
      expect(h.secrets.save).not.toHaveBeenCalled();
      expect(h.controller.snapshot().enrolled).toBe(false);
      expect(h.forks.children).toHaveLength(0);
    },
  );

  it("fails without keeping the token when secure storage is unavailable", async () => {
    const h = await setup();
    h.secrets.save.mockRejectedValueOnce(new Error("Secure storage is not available"));
    await expect(h.controller.enroll("123456")).resolves.toEqual({ ok: false, reason: "disabled" });
    expect(h.controller.snapshot().enrolled).toBe(false);
    expect(h.forks.children).toHaveLength(0);
    expect(h.logLines.join("\n")).not.toContain("tok-secret-value");
  });

  it("answers a double submit with one request", async () => {
    let finish: () => void = () => undefined;
    const h = createControllerHarness({
      scan: foundPrinter(),
      enroll: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, credentials: { ...CREDENTIALS, label: null } });
        }),
    });
    await h.controller.initialize();
    const first = h.controller.enroll("123456");
    const second = h.controller.enroll("123456");
    finish();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(h.enroll).toHaveBeenCalledTimes(1);
  });
});

describe("revocation and re-enrollment", () => {
  async function revoked() {
    const h = await started();
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ cloud: "revoked", lastError: "credentials_rejected" }) });
    await finishStop(h);
    await vi.waitFor(() => expect(h.controller.snapshot().status.color).toBe("red"));
    return h;
  }

  it("goes red, drops the dead token and stops the relay", async () => {
    const h = await revoked();
    const snapshot = h.controller.snapshot();
    expect(snapshot.status).toMatchObject({ color: "red", headline: "This laptop was removed. Ask an admin for a new code." });
    expect(snapshot.enrolled).toBe(false);
    expect(h.secrets.clear).toHaveBeenCalled();
    expect(h.prefsFs.saved()).toMatchObject({ revoked: true });
    expect(h.forks.last().types()).toContain("stop");
  });

  it("opens the code step from the red state", async () => {
    const h = await revoked();
    h.controller.beginReenroll();
    expect(h.controller.snapshot().setupStep).toBe("code");
    expect(h.ui.showSetupWindow).toHaveBeenCalled();
  });

  it("reaches the code step through advance, without the printer step", async () => {
    const h = await revoked();
    expect((await h.controller.advance()).setupStep).toBe("code");
  });

  it("clears the red state and restarts the relay after a new code", async () => {
    const h = await revoked();
    h.controller.beginReenroll();
    await expect(h.controller.enroll("654321")).resolves.toEqual({ ok: true });

    expect(h.prefsFs.saved()).toMatchObject({ revoked: false });
    expect(h.controller.snapshot().enrolled).toBe(true);
    expect(h.forks.children).toHaveLength(2);
    expect(h.forks.last().messages[0]).toMatchObject({ type: "start" });
  });

  it("goes back to the code step when a revocation lands during setup", async () => {
    const h = createControllerHarness({ scan: foundPrinter() });
    await h.controller.initialize();
    await h.controller.enroll("123456");
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ cloud: "revoked" }) });
    await finishStop(h);
    await vi.waitFor(() => expect(h.controller.snapshot().setupStep).toBe("code"));
  });
});

describe("setup flow", () => {
  it("moves welcome -> printer -> code -> connected -> test print -> done, gated by main", async () => {
    const h = createControllerHarness({ scan: NO_PRINTER });
    await h.controller.initialize();
    expect(h.controller.snapshot().setupStep).toBe("welcome");

    expect((await h.controller.advance()).setupStep).toBe("printer");
    // No printer yet: the step holds.
    expect((await h.controller.advance()).setupStep).toBe("printer");

    h.state.scan = foundPrinter("missing");
    await h.controller.scanPrinters();
    expect((await h.controller.advance()).setupStep).toBe("printer");

    h.state.scan = foundPrinter("ready");
    await h.controller.scanPrinters();
    expect((await h.controller.advance()).setupStep).toBe("code");
    // Not enrolled yet: the step holds.
    expect((await h.controller.advance()).setupStep).toBe("code");

    await h.controller.enroll("123456");
    expect(h.controller.snapshot().setupStep).toBe("connected");
    // The cloud has not answered yet.
    expect((await h.controller.advance()).setupStep).toBe("connected");

    h.forks.last().emitMessage({ type: "event", event: relayStatus() });
    expect((await h.controller.advance()).setupStep).toBe("test-print");
    expect((await h.controller.advance()).setupStep).toBe("test-print");

    await h.controller.confirmTestPrint(false);
    expect((await h.controller.advance()).setupStep).toBe("test-print");
    await h.controller.confirmTestPrint(true);
    expect((await h.controller.advance()).setupStep).toBe("done");

    expect(h.ui.closeSetupWindow).not.toHaveBeenCalled();
    expect((await h.controller.advance()).setupStep).toBeNull();
    expect(h.ui.closeSetupWindow).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.prefsFs.saved()).toMatchObject({ setupComplete: true }));
  });

  it("does not skip ahead from welcome by calling advance repeatedly", async () => {
    const h = createControllerHarness({ scan: NO_PRINTER });
    await h.controller.initialize();
    for (let i = 0; i < 6; i += 1) await h.controller.advance();
    expect(h.controller.snapshot().setupStep).toBe("printer");
  });
});

describe("test print", () => {
  async function running(options: HarnessOptions = ENROLLED) {
    const h = await started(options);
    h.forks.last().emitMessage({ type: "event", event: relayStatus() });
    return h;
  }

  it("reports no printer before the relay knows one", async () => {
    const h = await started();
    await expect(h.controller.requestTestPrint()).resolves.toEqual({ ok: false, reason: "no_printer" });
  });

  it("asks the relay to print on the cloud's printer", async () => {
    const h = await running();
    const pending = h.controller.requestTestPrint();
    await vi.waitFor(() => expect(h.forks.last().messages.at(-1)).toEqual({ type: "testPrint", printerId: "printer-1" }));
    h.forks.last().emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: true, transportOutcome: "sent" });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it.each([
    ["paused", "paused"],
    ["busy", "busy"],
    ["unknown_printer", "no_printer"],
    ["printer_unavailable", "printer_not_ready"],
    ["cloud_unreachable", "failed"],
  ] as const)("maps the relay's %s to %s", async (error, reason) => {
    const h = await running();
    const pending = h.controller.requestTestPrint();
    await vi.waitFor(() => expect(h.forks.last().messages.at(-1)).toMatchObject({ type: "testPrint" }));
    h.forks.last().emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: false, error });
    await expect(pending).resolves.toEqual({ ok: false, reason });
  });

  it("refuses while paused, without bothering the relay", async () => {
    const h = await running();
    await h.controller.setPaused(true);
    await expect(h.controller.requestTestPrint()).resolves.toEqual({ ok: false, reason: "paused" });
    expect(h.forks.last().types()).not.toContain("testPrint");
  });

  it("from the menu, asks whether a label came out and remembers a yes", async () => {
    const h = await running();
    const pending = h.controller.testPrintFromMenu();
    await vi.waitFor(() => expect(h.forks.last().messages.at(-1)).toMatchObject({ type: "testPrint" }));
    h.forks.last().emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: true });
    await pending;
    expect(h.ui.askLabelCameOut).toHaveBeenCalledTimes(1);
  });

  it("from the menu, shows the window instead when the test could not be sent", async () => {
    const h = await started();
    await h.controller.testPrintFromMenu();
    expect(h.ui.askLabelCameOut).not.toHaveBeenCalled();
    expect(h.ui.showSetupWindow).toHaveBeenCalled();
  });
});

describe("pause and settings", () => {
  it("forwards pause and resume and shows them", async () => {
    const h = await started();
    await h.controller.setPaused(true);
    expect(h.controller.snapshot().paused).toBe(true);
    await h.controller.setPaused(false);
    expect(h.forks.last().types()).toEqual(["start", "pause", "resume"]);
    expect(h.controller.snapshot().paused).toBe(false);
  });

  it("changes the update channel, remembers it and tells the updater", async () => {
    const h = await started();
    await h.controller.setChannel("preview");
    expect(h.prefsFs.saved()).toMatchObject({ channel: "preview" });
    expect(h.updates.setChannel).toHaveBeenCalledWith("preview");
    expect(h.controller.snapshot().channel).toBe("preview");
  });

  it("ignores a channel it does not know", async () => {
    const h = await started();
    await h.controller.setChannel("nightly" as never);
    expect(h.updates.setChannel).not.toHaveBeenCalled();
    expect(h.controller.snapshot().channel).toBe("stable");
  });

  it("shows the update state in the snapshot", async () => {
    const h = await started();
    h.controller.setUpdateState({ kind: "ready", version: "0.2.0" });
    expect(h.controller.snapshot().update).toEqual({ kind: "ready", version: "0.2.0" });
  });
});

describe("warnings", () => {
  it("always warns about the lid, never claims it works closed, and adds battery, sleep and lock notes", async () => {
    const h = await started();
    const base = h.controller.snapshot().warnings;
    expect(base).toHaveLength(1);
    expect(base[0]).toMatch(/keep the lid open/i);

    h.controller.setPowerContext({ onBattery: true });
    h.controller.setPowerContext({ asleep: true });
    h.controller.setPowerContext({ locked: true });
    const all = h.controller.snapshot().warnings;
    expect(all).toHaveLength(4);
    expect(all.join(" ")).toMatch(/battery/i);
    expect(all.join(" ")).toMatch(/asleep|sleep/i);
    expect(all.join(" ")).toMatch(/locked/i);
    expect(all.join(" ")).not.toMatch(/works? with the lid closed|prints? with the lid closed/i);

    h.controller.setPowerContext({ onBattery: false, asleep: false, locked: false });
    expect(h.controller.snapshot().warnings).toEqual(base);
  });

  it("re-reads the printer and the legacy agent on refresh", async () => {
    const h = await started();
    const scans = vi.mocked(h.printers.scan).mock.calls.length;
    await h.controller.refresh();
    expect(vi.mocked(h.printers.scan).mock.calls.length).toBe(scans + 1);
    expect(h.legacy.detect).toHaveBeenCalledTimes(2);
  });
});

describe("snapshots", () => {
  it("notifies subscribers and stops after unsubscribe", async () => {
    const h = await started();
    const listener = vi.fn();
    const off = h.controller.subscribe(listener);
    await h.controller.setPaused(true);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    off();
    await h.controller.setPaused(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("carries counts only: no token, no ZPL, no names", async () => {
    const h = await started();
    h.forks.last().emitMessage({
      type: "event",
      event: relayStatus({ counts: { claimed: 3, sent: 2, failed: 1, ambiguous: 0 } }),
    });
    const snapshot = h.controller.snapshot();
    expect(snapshot.recentJobs).toEqual({ sent: 2, failed: 1, ambiguous: 0 });
    expect(JSON.stringify(snapshot)).not.toMatch(/tok-secret|\^XA/);
  });
});

describe("shutdown", () => {
  it("stops the relay, releases the power hold and the scan timer", async () => {
    const h = await started();
    const pending = h.controller.shutdown();
    h.forks.last().emitMessage({ type: "stopped" });
    await expect(pending).resolves.toEqual({ outcome: "stopped", jobInFlight: false });
    expect(h.power.dispose).toHaveBeenCalled();
    expect([...h.timers.pending.values()].filter((timer) => timer.kind === "interval")).toHaveLength(0);
  });

  it("reports abandoned while a label is writing, and settles only when the relay stops", async () => {
    const h = await started();
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ inFlight: true }) });
    const shutdown = h.controller.shutdown();
    h.timers.fire("timeout");
    h.timers.fire("timeout");
    h.timers.fire("timeout");
    await expect(shutdown).resolves.toEqual({ outcome: "abandoned", jobInFlight: true });
    expect(h.forks.last().kills).toBe(0);

    const settled = vi.fn();
    void h.controller.settled().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    h.forks.last().emitMessage({ type: "stopped" });
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
  });

  it("reports a send that was still writing", async () => {
    const h = await started();
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ inFlight: true }) });
    expect(h.controller.jobInFlight()).toBe(true);
  });
});
