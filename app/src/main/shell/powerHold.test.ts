/**
 * D5, as the app wires it: `powerSaveBlocker('prevent-app-suspension')` is held exactly while a printer
 * is attached and a job arrived in the last 30 minutes. These run the real controller and the real power
 * controller against a fake blocker and a fake clock.
 */

import { describe, expect, it } from "vitest";

import { ACTIVE_WINDOW_MS } from "../services";
import { CREDENTIALS, createControllerHarness, foundPrinter, NO_PRINTER, type ControllerHarness } from "./testing/controllerHarness";
import { relayStatus } from "./testing/fakeChild";

const MINUTE = 60_000;

async function started() {
  const h = createControllerHarness({
    credentials: CREDENTIALS,
    scan: foundPrinter(),
    prefs: { openAtLogin: true, setupComplete: true },
    realPower: true,
  });
  await h.controller.initialize();
  return h;
}

/** A job that arrived `minutesAgo` minutes before the fake clock's now. */
const jobAt = (h: ControllerHarness, minutesAgo: number) => new Date(h.clock.now.getTime() - minutesAgo * MINUTE).toISOString();

const reportJob = (h: ControllerHarness, minutesAgo: number) =>
  h.forks.last().emitMessage({ type: "event", event: relayStatus({ lastJobAt: jobAt(h, minutesAgo) }) });

describe("the sleep hold", () => {
  it("is 30 minutes", () => {
    expect(ACTIVE_WINDOW_MS).toBe(30 * MINUTE);
  });

  it("is not taken while a printer is attached but no job has arrived", async () => {
    const h = await started();
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ lastJobAt: null }) });
    expect(h.blocker.start).not.toHaveBeenCalled();
    expect(h.blocker.active.size).toBe(0);
  });

  it("is taken when a job arrives with the printer attached, as prevent-app-suspension", async () => {
    const h = await started();
    reportJob(h, 1);
    expect(h.blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
    expect(h.blocker.active.size).toBe(1);
  });

  it("is held once, however many status events follow", async () => {
    const h = await started();
    reportJob(h, 1);
    reportJob(h, 1);
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ lastJobAt: jobAt(h, 1), inFlight: true }) });
    await h.controller.scanPrinters();
    expect(h.blocker.start).toHaveBeenCalledTimes(1);
  });

  it("is not taken for a job older than 30 minutes", async () => {
    const h = await started();
    reportJob(h, 31);
    expect(h.blocker.start).not.toHaveBeenCalled();
  });

  describe("expiry", () => {
    it("is released when 30 minutes have passed since the last job", async () => {
      const h = await started();
      reportJob(h, 1);
      const id = h.blocker.start.mock.results[0].value as number;

      // The power controller asked to be woken when the window ends.
      expect([...h.timers.pending.values()].some((timer) => timer.ms === 29 * MINUTE)).toBe(true);

      h.clock.now = new Date(h.clock.now.getTime() + 29 * MINUTE);
      h.timers.fire("timeout");
      expect(h.blocker.stop).toHaveBeenCalledExactlyOnceWith(id);
      expect(h.blocker.active.size).toBe(0);
    });

    it("is kept when a newer job arrives before the window ends, and then ends 30 minutes after that one", async () => {
      const h = await started();
      reportJob(h, 20);
      h.clock.now = new Date(h.clock.now.getTime() + 15 * MINUTE);
      reportJob(h, 1);
      expect(h.blocker.start).toHaveBeenCalledTimes(1);
      expect(h.blocker.stop).not.toHaveBeenCalled();

      h.clock.now = new Date(h.clock.now.getTime() + 29 * MINUTE);
      h.timers.fire("timeout");
      expect(h.blocker.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("detach and attach", () => {
    it("is released at once when the printer is unplugged", async () => {
      const h = await started();
      reportJob(h, 1);
      h.state.scan = NO_PRINTER;
      await h.controller.scanPrinters();
      expect(h.blocker.stop).toHaveBeenCalledTimes(1);
      expect(h.blocker.active.size).toBe(0);
    });

    it("is not taken for a job while the printer is unplugged", async () => {
      const h = await started();
      h.state.scan = NO_PRINTER;
      await h.controller.scanPrinters();
      reportJob(h, 1);
      expect(h.blocker.start).not.toHaveBeenCalled();
    });

    it("is taken again when the printer comes back inside the window", async () => {
      const h = await started();
      reportJob(h, 1);
      h.state.scan = NO_PRINTER;
      await h.controller.scanPrinters();
      h.state.scan = foundPrinter();
      await h.controller.scanPrinters();
      expect(h.blocker.start).toHaveBeenCalledTimes(2);
      expect(h.blocker.active.size).toBe(1);
    });

    it("is not taken again when the printer comes back after the window", async () => {
      const h = await started();
      reportJob(h, 1);
      h.state.scan = NO_PRINTER;
      await h.controller.scanPrinters();
      h.clock.now = new Date(h.clock.now.getTime() + 45 * MINUTE);
      h.state.scan = foundPrinter();
      await h.controller.scanPrinters();
      expect(h.blocker.start).toHaveBeenCalledTimes(1);
      expect(h.blocker.active.size).toBe(0);
    });
  });

  describe("shutdown", () => {
    it("is released when the app shuts down", async () => {
      const h = await started();
      reportJob(h, 1);
      const id = h.blocker.start.mock.results[0].value as number;

      const shutdown = h.controller.shutdown();
      h.forks.last().emitMessage({ type: "stopped" });
      h.forks.last().emitExit(0);
      await shutdown;

      expect(h.blocker.stop).toHaveBeenCalledExactlyOnceWith(id);
      expect(h.blocker.active.size).toBe(0);
      // And no timer is left to take it again.
      expect([...h.timers.pending.values()]).toEqual([]);
    });

    it("is not taken again by a status event from a send that was still finishing", async () => {
      const h = await started();
      reportJob(h, 1);
      const shutdown = h.controller.shutdown();
      // The last label finishes while the relay is stopping.
      reportJob(h, 0);
      await h.controller.scanPrinters();
      h.forks.last().emitMessage({ type: "stopped" });
      h.forks.last().emitExit(0);
      await shutdown;

      expect(h.blocker.start).toHaveBeenCalledTimes(1);
      expect(h.blocker.active.size).toBe(0);
    });

    it("does nothing when no hold was taken", async () => {
      const h = await started();
      const shutdown = h.controller.shutdown();
      h.forks.last().emitMessage({ type: "stopped" });
      h.forks.last().emitExit(0);
      await shutdown;
      expect(h.blocker.stop).not.toHaveBeenCalled();
    });
  });
});

describe("production wiring", () => {
  it("passes Electron's powerSaveBlocker to the power controller, and releases it from the quit path", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*\bpowerSaveBlocker\b[^}]*\}\s*from\s*"electron"/);
    expect(source).toMatch(/createPowerController\(\{\s*blocker:\s*powerSaveBlocker\s*\}\)/);
    // The quit path goes through the controller's shutdown, which disposes the power controller.
    expect(source).toMatch(/shutdown:\s*\(\)\s*=>\s*controller\.shutdown\(\)/);
  });
});
