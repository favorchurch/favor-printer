import { describe, expect, it, vi } from "vitest";

import { createUpdateController, type UpdaterAdapter, type UpdaterEvent } from "../services";
import { createFakeTimers } from "../services/testing/fakes";
import { createQuitCoordinator, type QuitDeps } from "./quit";
import { createControllerHarness, CREDENTIALS, foundPrinter } from "./testing/controllerHarness";
import { relayStatus } from "./testing/fakeChild";

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => void (resolve = done));
  return { promise, resolve };
}

function setup(patch: Partial<QuitDeps> & { decision?: "install" | "defer" | "none" } = {}) {
  const order: string[] = [];
  const coordinatorRef: { current: ReturnType<typeof createQuitCoordinator> | null } = { current: null };
  const deps: QuitDeps = {
    shutdown: vi.fn(async () => ({ outcome: "stopped" as const, jobInFlight: false })),
    settled: vi.fn(async () => undefined),
    updates: {
      stop: vi.fn(() => void order.push("updates.stop")),
      beforeQuit: vi.fn((jobInFlight: boolean) => {
        order.push(`beforeQuit(${jobInFlight}) allowed=${coordinatorRef.current?.isQuitAllowed()}`);
        return patch.decision ?? "none";
      }),
    },
    quit: vi.fn(() => void order.push("quit")),
    ...patch,
  };
  const coordinator = createQuitCoordinator(deps);
  coordinatorRef.current = coordinator;
  return { coordinator, deps, order };
}

describe("quit coordinator", () => {
  it("stops the update checks, stops the relay, then quits", async () => {
    const { coordinator, deps, order } = setup();
    expect(coordinator.isQuitAllowed()).toBe(false);
    await coordinator.request();
    expect(order).toEqual(["updates.stop", "beforeQuit(false) allowed=true", "quit"]);
    expect(deps.settled).not.toHaveBeenCalled();
    expect(coordinator.isQuitAllowed()).toBe(true);
  });

  it("lets an install quit the app itself, with before-quit already allowed", async () => {
    const { coordinator, deps, order } = setup({ decision: "install" });
    await coordinator.request();
    expect(order).toEqual(["updates.stop", "beforeQuit(false) allowed=true"]);
    expect(deps.quit).not.toHaveBeenCalled();
  });

  describe("when the relay was abandoned mid-send", () => {
    it("stays open until the relay settles, then quits", async () => {
      const settled = deferred();
      const { coordinator, deps, order } = setup({
        shutdown: vi.fn(async () => ({ outcome: "abandoned" as const, jobInFlight: true })),
        settled: vi.fn(() => settled.promise),
      });
      const request = coordinator.request();
      await vi.waitFor(() => expect(deps.settled).toHaveBeenCalled());

      expect(deps.quit).not.toHaveBeenCalled();
      expect(deps.updates.beforeQuit).not.toHaveBeenCalled();
      expect(coordinator.isQuitAllowed()).toBe(false);

      settled.resolve();
      await request;
      expect(order).toEqual(["updates.stop", "beforeQuit(false) allowed=true", "quit"]);
      expect(coordinator.isQuitAllowed()).toBe(true);
    });

    it("installs a pending update once the relay settles, not before", async () => {
      const settled = deferred();
      const { coordinator, deps, order } = setup({
        decision: "install",
        shutdown: vi.fn(async () => ({ outcome: "abandoned" as const, jobInFlight: true })),
        settled: vi.fn(() => settled.promise),
      });
      const request = coordinator.request();
      await vi.waitFor(() => expect(deps.settled).toHaveBeenCalled());
      expect(deps.updates.beforeQuit).not.toHaveBeenCalled();

      settled.resolve();
      await request;
      // The job has settled, so the policy sees no job in flight and installs.
      expect(order).toEqual(["updates.stop", "beforeQuit(false) allowed=true"]);
      expect(deps.quit).not.toHaveBeenCalled();
    });
  });

  it("holds further quit requests while one is waiting, so the app cannot exit mid-send", async () => {
    const settled = deferred();
    const { coordinator, deps } = setup({
      shutdown: vi.fn(async () => ({ outcome: "abandoned" as const, jobInFlight: true })),
      settled: vi.fn(() => settled.promise),
    });
    const first = coordinator.request();
    await vi.waitFor(() => expect(deps.settled).toHaveBeenCalled());

    await coordinator.request();
    await coordinator.request();
    expect(deps.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.quit).not.toHaveBeenCalled();
    expect(coordinator.isQuitAllowed()).toBe(false);

    settled.resolve();
    await first;
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it("clears its latch when shutdown fails, so quitting can be tried again", async () => {
    const shutdown = vi
      .fn<QuitDeps["shutdown"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ outcome: "stopped", jobInFlight: false });
    const { coordinator, deps } = setup({ shutdown });

    await expect(coordinator.request()).rejects.toThrow("boom");
    expect(coordinator.isQuitAllowed()).toBe(false);
    expect(deps.quit).not.toHaveBeenCalled();

    await coordinator.request();
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it("clears its latch when waiting for the relay fails", async () => {
    const { coordinator, deps } = setup({
      shutdown: vi.fn(async () => ({ outcome: "abandoned" as const, jobInFlight: true })),
      settled: vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValue(undefined),
    });
    await expect(coordinator.request()).rejects.toThrow("lost");
    expect(coordinator.isQuitAllowed()).toBe(false);
    await coordinator.request();
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });
});

describe("quit with the real controller, supervisor and update policy", () => {
  function fakeAdapter() {
    let listener: (event: UpdaterEvent) => void = () => undefined;
    const adapter: UpdaterAdapter = {
      configure: vi.fn(),
      subscribe: (next) => void (listener = next),
      check: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(),
    };
    return { adapter, emit: (event: UpdaterEvent) => listener(event) };
  }

  async function running(updateReady: boolean) {
    const h = createControllerHarness({ credentials: CREDENTIALS, scan: foundPrinter(), prefs: { openAtLogin: true, setupComplete: true } });
    await h.controller.initialize();
    h.forks.last().emitMessage({ type: "event", event: relayStatus({ inFlight: true }) });

    const { adapter, emit } = fakeAdapter();
    const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
    if (updateReady) emit({ kind: "downloaded", version: "0.2.0" });
    const appQuit = vi.fn();
    const coordinator = createQuitCoordinator({
      shutdown: () => h.controller.shutdown(),
      settled: () => h.controller.settled(),
      updates,
      quit: appQuit,
    });
    return { h, adapter, appQuit, coordinator };
  }

  /** Runs the stop wait out: a label is still writing at the ceiling, so the relay is abandoned. */
  async function reachCeiling(h: Awaited<ReturnType<typeof running>>["h"]) {
    for (let i = 0; i < 3; i += 1) h.timers.fire("timeout");
    await Promise.resolve();
  }

  /** What a real relay does: posts stopped, then exits. */
  const finishRelay = (h: Awaited<ReturnType<typeof running>>["h"]) => {
    h.forks.last().emitMessage({ type: "stopped" });
    h.forks.last().emitExit(0);
  };

  it("without an update: neither quits nor kills until the relay reports stopped, then quits once", async () => {
    const { h, appQuit, coordinator } = await running(false);
    const request = coordinator.request();
    await reachCeiling(h);

    expect(h.forks.last().kills).toBe(0);
    expect(appQuit).not.toHaveBeenCalled();
    expect(coordinator.isQuitAllowed()).toBe(false);

    finishRelay(h);
    await request;
    expect(appQuit).toHaveBeenCalledTimes(1);
    expect(coordinator.isQuitAllowed()).toBe(true);
  });

  it("with an update ready: installs once the relay reports stopped, and does not quit the app a second way", async () => {
    const { h, adapter, appQuit, coordinator } = await running(true);
    const request = coordinator.request();
    await reachCeiling(h);

    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    expect(appQuit).not.toHaveBeenCalled();

    finishRelay(h);
    await request;
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(appQuit).not.toHaveBeenCalled();
    expect(coordinator.isQuitAllowed()).toBe(true);
  });

  it("also finishes when the relay exits without saying stopped", async () => {
    const { h, appQuit, coordinator } = await running(false);
    const request = coordinator.request();
    await reachCeiling(h);
    h.forks.last().emitExit(0);
    await request;
    expect(appQuit).toHaveBeenCalledTimes(1);
  });
});
