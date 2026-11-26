/**
 * Install safety, as a property over event sequences: whatever order jobs start and finish, spool
 * reconciliation begins and ends, an update becomes ready and the volunteer quits, `quitAndInstall`
 * is never called while a job is in flight or reconciliation is pending, and an install that was
 * held back happens once after both clear.
 *
 * Two layers. The first drives the update policy directly. The second drives the real supervisor,
 * controller and quit coordinator against a hand-driven relay child, so what ships is what is checked.
 */

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { propertyParams } from "../../shared/testing/property";
import { createFakeTimers } from "./testing/fakes";
import { createUpdateController, type UpdaterAdapter, type UpdaterEvent } from "./updates";
import { createQuitCoordinator } from "../shell/quit";
import { createControllerHarness, CREDENTIALS, foundPrinter } from "../shell/testing/controllerHarness";
import { relayStatus } from "../shell/testing/fakeChild";

type PolicyOp = "jobStart" | "jobFinish" | "reconcileStart" | "reconcileEnd" | "updateReady" | "quit";
const policyOps = fc.array(
  fc.constantFrom<PolicyOp>("jobStart", "jobFinish", "reconcileStart", "reconcileEnd", "updateReady", "quit"),
  { maxLength: 40 },
);

describe("install policy: never while a job is in flight or reconciliation is pending", () => {
  it("holds for any sequence of job, reconciliation, update-ready and quit events", () => {
    fc.assert(
      fc.property(policyOps, (ops) => {
        let listener: (event: UpdaterEvent) => void = () => undefined;
        let jobs = 0;
        let reconciling = false;
        const unsafe: string[] = [];
        const adapter: UpdaterAdapter = {
          configure: vi.fn(),
          subscribe: (next) => void (listener = next),
          check: vi.fn(async () => undefined),
          quitAndInstall: vi.fn(() => {
            if (jobs > 0 || reconciling) unsafe.push(`jobs=${jobs} reconciling=${reconciling}`);
          }),
        };
        const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
        const busy = () => jobs > 0 || reconciling;
        let ready = false;
        let quitting = false;
        /** The caller's side of the contract: tell the policy when the last thing in the way clears. */
        const cleared = () => {
          if (!busy()) updates.jobsSettled();
        };

        for (const op of ops) {
          switch (op) {
            case "jobStart":
              jobs += 1;
              break;
            case "jobFinish":
              if (jobs > 0) jobs -= 1;
              cleared();
              break;
            case "reconcileStart":
              reconciling = true;
              break;
            case "reconcileEnd":
              reconciling = false;
              cleared();
              break;
            case "updateReady":
              ready = true;
              listener({ kind: "downloaded", version: "0.3.0-beta.5" });
              break;
            case "quit":
              quitting = true;
              updates.beforeQuit(busy());
              break;
          }
        }
        expect(unsafe).toEqual([]);
        const during = vi.mocked(adapter.quitAndInstall).mock.calls.length;
        expect(during).toBeLessThanOrEqual(1);

        // Let everything clear: a deferred install must now happen, once, and never without a quit.
        jobs = 0;
        reconciling = false;
        updates.jobsSettled();
        updates.jobsSettled();
        const total = vi.mocked(adapter.quitAndInstall).mock.calls.length;
        expect(unsafe).toEqual([]);
        expect(total).toBeLessThanOrEqual(1);
        if (!quitting || !ready) expect(total).toBe(0);
      }),
      propertyParams(300),
    );
  });

  it("installs a held-back update once after the last blocker clears, and not before", () => {
    let listener: (event: UpdaterEvent) => void = () => undefined;
    const adapter: UpdaterAdapter = {
      configure: vi.fn(),
      subscribe: (next) => void (listener = next),
      check: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(),
    };
    const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
    listener({ kind: "downloaded", version: "0.3.0-beta.5" });
    expect(updates.beforeQuit(true)).toBe("defer");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    updates.jobsSettled();
    updates.jobsSettled();
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

type RelayOp = "jobStart" | "jobFinish" | "reconcileStart" | "reconcileEnd" | "updateReady" | "quit" | "tick" | "relayStops";
const relayOps = fc.array(
  fc.constantFrom<RelayOp>("jobStart", "jobFinish", "reconcileStart", "reconcileEnd", "updateReady", "quit", "tick", "relayStops"),
  { maxLength: 30 },
);

describe("install policy through the real supervisor and quit coordinator", () => {
  it("never installs while a live relay is sending or reconciling, and installs once after it has stopped", async () => {
    await fc.assert(
      fc.asyncProperty(relayOps, async (ops) => {
        const h = createControllerHarness({ credentials: CREDENTIALS, scan: foundPrinter(), prefs: { openAtLogin: true, setupComplete: true } });
        await h.controller.initialize();
        const child = h.forks.last();
        child.emitMessage({ type: "event", event: relayStatus() });

        let listener: (event: UpdaterEvent) => void = () => undefined;
        let jobInFlight = false;
        let reconciling = false;
        let alive = true;
        let ready = false;
        let readyWhenDecided: boolean | null = null;
        const unsafe: string[] = [];
        const adapter: UpdaterAdapter = {
          configure: vi.fn(),
          subscribe: (next) => void (listener = next),
          check: vi.fn(async () => undefined),
          quitAndInstall: vi.fn(() => {
            // The supervisor ends an idle relay that outlives the stop wait. Its spool keeps whatever it was
            // reconciling for the next start, so a relay that was ended no longer counts as reconciling.
            const live = alive && child.kills === 0;
            if (jobInFlight || (live && reconciling)) unsafe.push(`jobInFlight=${jobInFlight} reconciling=${reconciling} live=${live}`);
          }),
        };
        const real = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
        const updates = {
          stop: () => real.stop(),
          beforeQuit: (inFlight: boolean) => {
            readyWhenDecided = real.state().kind === "ready";
            return real.beforeQuit(inFlight);
          },
        };
        const appQuit = vi.fn();
        const coordinator = createQuitCoordinator({
          shutdown: () => h.controller.shutdown(),
          settled: () => h.controller.settled(),
          updates,
          quit: appQuit,
        });

        let request: Promise<void> | null = null;
        const flush = async () => {
          for (let i = 0; i < 5; i += 1) await Promise.resolve();
        };
        /** The relay child's own rule: it reports stopped only after it was told to stop, with no send open and nothing left to reconcile. */
        const relayStops = () => {
          if (!alive || !child.types().includes("stop") || jobInFlight || reconciling) return;
          alive = false;
          child.emitMessage({ type: "stopped" });
          child.emitExit(0);
        };

        for (const op of ops) {
          switch (op) {
            case "jobStart":
              if (alive && !child.types().includes("stop")) {
                jobInFlight = true;
                child.emitMessage({ type: "event", event: relayStatus({ inFlight: true }) });
              }
              break;
            case "jobFinish":
              if (alive && jobInFlight) {
                jobInFlight = false;
                child.emitMessage({ type: "event", event: relayStatus({ inFlight: false }) });
              }
              break;
            case "reconcileStart":
              reconciling = true;
              break;
            case "reconcileEnd":
              reconciling = false;
              break;
            case "updateReady":
              ready = true;
              listener({ kind: "downloaded", version: "0.3.0-beta.5" });
              break;
            case "quit":
              request ??= coordinator.request();
              break;
            case "tick":
              h.timers.fire("timeout");
              break;
            case "relayStops":
              relayStops();
              break;
          }
          await flush();
        }
        expect(unsafe).toEqual([]);

        // Everything clears: the relay finishes its send and its reconciliation, and is allowed to stop.
        if (request) {
          for (let i = 0; i < 8 && alive; i += 1) {
            if (jobInFlight) child.emitMessage({ type: "event", event: relayStatus({ inFlight: false }) });
            jobInFlight = false;
            reconciling = false;
            h.timers.fire("timeout");
            await flush();
            relayStops();
            await flush();
          }
          await request;
        }
        expect(unsafe).toEqual([]);

        const installs = vi.mocked(adapter.quitAndInstall).mock.calls.length;
        expect(installs).toBeLessThanOrEqual(1);
        if (request) {
          expect(coordinator.isQuitAllowed()).toBe(true);
          // Installing quits the app itself, so the app is never quit a second way.
          expect(installs + appQuit.mock.calls.length).toBe(1);
          expect(installs).toBe(readyWhenDecided === true ? 1 : 0);
        } else {
          expect(installs).toBe(0);
        }
        void ready;
      }),
      propertyParams(150),
    );
  });
});
