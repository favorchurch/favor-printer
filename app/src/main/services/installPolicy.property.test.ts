/**
 * Install safety, as a property over event sequences: whatever order jobs are claimed, start and finish,
 * spool reconciliation begins and ends, an update becomes ready and the volunteer quits, `quitAndInstall`
 * is never called while a job is in flight, reconciliation is pending, claimed jobs still have no recorded
 * outcome, or the relay had to be ended. An install that was held back happens once on a later clean quit.
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

const VERSION = "0.3.0-beta.5";

function fakeAdapter(onInstall: () => void = () => undefined) {
  let listener: (event: UpdaterEvent) => void = () => undefined;
  const adapter: UpdaterAdapter = {
    configure: vi.fn(),
    subscribe: (next) => void (listener = next),
    check: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(onInstall),
  };
  return { adapter, emit: (event: UpdaterEvent) => listener(event), installs: () => vi.mocked(adapter.quitAndInstall).mock.calls.length };
}

type PolicyOp = "jobStart" | "jobFinish" | "reconcileStart" | "reconcileEnd" | "queue" | "record" | "updateReady" | "quit";
const policyOps = fc.array(
  fc.constantFrom<PolicyOp>("jobStart", "jobFinish", "reconcileStart", "reconcileEnd", "queue", "record", "updateReady", "quit"),
  { maxLength: 40 },
);

describe("install policy: never while a job is in flight, reconciling or has no recorded outcome", () => {
  it("holds for any sequence of job, reconciliation, pending-entry, update-ready and quit events", () => {
    fc.assert(
      fc.property(policyOps, (ops) => {
        let jobs = 0;
        let reconciling = false;
        let pending = 0;
        const unsafe: string[] = [];
        const { adapter, emit, installs } = fakeAdapter(() => {
          if (jobs > 0 || reconciling || pending > 0) unsafe.push(`jobs=${jobs} reconciling=${reconciling} pending=${pending}`);
        });
        const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
        const busy = () => jobs > 0 || reconciling || pending > 0;
        let ready = false;
        let quitting = false;
        /** The caller's side of the contract: tell the policy when the last thing in the way clears. */
        const cleared = () => {
          if (!busy()) updates.jobsSettled(jobs > 0, pending, reconciling ? "pending" : "complete");
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
            case "queue":
              pending += 1;
              break;
            case "record":
              if (pending > 0) pending -= 1;
              cleared();
              break;
            case "updateReady":
              ready = true;
              emit({ kind: "downloaded", version: VERSION });
              break;
            case "quit":
              quitting = true;
              updates.beforeQuit(jobs > 0, pending, reconciling ? "pending" : "complete");
              break;
          }
        }
        expect(unsafe).toEqual([]);
        expect(installs()).toBeLessThanOrEqual(1);

        // Let everything clear: a deferred install must now happen, once, and never without a quit.
        jobs = 0;
        reconciling = false;
        pending = 0;
        updates.jobsSettled(false, 0, "complete");
        updates.jobsSettled(false, 0, "complete");
        expect(unsafe).toEqual([]);
        expect(installs()).toBeLessThanOrEqual(1);
        if (!quitting || !ready) expect(installs()).toBe(0);
      }),
      propertyParams(300),
    );
  });

  it("holds a ready update back while entries are pending, and installs once after they are recorded", () => {
    const { adapter, emit, installs } = fakeAdapter();
    const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
    emit({ kind: "downloaded", version: VERSION });
    expect(updates.beforeQuit(false, 2, "complete")).toBe("defer");
    expect(installs()).toBe(0);
    updates.jobsSettled(false, 0, "complete");
    updates.jobsSettled(false, 0, "complete");
    expect(installs()).toBe(1);
  });

  it("installs a held-back update once after the last blocker clears, and not before", () => {
    const { adapter, emit, installs } = fakeAdapter();
    const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
    emit({ kind: "downloaded", version: VERSION });
    expect(updates.beforeQuit(true, 0, "complete")).toBe("defer");
    expect(installs()).toBe(0);
    updates.jobsSettled(false, 0, "complete");
    updates.jobsSettled(false, 0, "complete");
    expect(installs()).toBe(1);
  });
});

/** A running relay behind the real supervisor and controller, a real update policy, and the real quit coordinator. */
async function session(onInstall: () => void = () => undefined) {
  const h = createControllerHarness({ credentials: CREDENTIALS, scan: foundPrinter(), prefs: { openAtLogin: true, setupComplete: true } });
  await h.controller.initialize();
  const child = h.forks.last();
  child.emitMessage({ type: "event", event: relayStatus() });
  const { adapter, emit, installs } = fakeAdapter(onInstall);
  const real = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
  const decided: { ready: boolean; inFlight: boolean; pending: number; reconciliation: "pending" | "complete" }[] = [];
  const updates = {
    stop: () => real.stop(),
    beforeQuit: (inFlight: boolean, pending: number, reconciliation: "pending" | "complete") => {
      decided.push({ ready: real.state().kind === "ready", inFlight, pending, reconciliation });
      return real.beforeQuit(inFlight, pending, reconciliation);
    },
  };
  const appQuit = vi.fn();
  const coordinator = createQuitCoordinator({
    shutdown: () => h.controller.shutdown(),
    settled: () => h.controller.settled(),
    pendingEntries: () => h.controller.pendingEntries(),
    reconciliationState: () => h.controller.reconciliationState(),
    updates,
    quit: appQuit,
  });
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return { h, child, adapter, emit, installs, real, decided, appQuit, coordinator, flush };
}

/** A later launch: the updater finds the downloaded update again, nothing is pending, the relay is idle, and the volunteer quits. */
async function laterCleanQuitInstalls(): Promise<number> {
  const s = await session();
  s.emit({ kind: "downloaded", version: VERSION });
  const request = s.coordinator.request();
  await s.flush();
  s.child.emitMessage({ type: "stopped" });
  s.child.emitExit(0);
  await request;
  expect(s.appQuit).not.toHaveBeenCalled();
  return s.installs();
}

type RelayOp =
  | "claim"
  | "jobStart"
  | "jobFinish"
  | "reconcileStart"
  | "reconcileEnd"
  | "updateReady"
  | "quit"
  | "tick"
  | "relayStops";
const relayOps = fc.array(
  fc.constantFrom<RelayOp>("claim", "jobStart", "jobFinish", "reconcileStart", "reconcileEnd", "updateReady", "quit", "tick", "relayStops"),
  { maxLength: 30 },
);

describe("install policy through the real supervisor and quit coordinator", () => {
  it("never installs while the relay is sending, reconciling, holds entries with no outcome or was ended, and a later clean quit installs once", async () => {
    await fc.assert(
      fc.asyncProperty(relayOps, async (ops) => {
        let claimed = 0;
        let recorded = 0;
        let jobInFlight = false;
        let reconciling = false;
        let alive = true;
        let ready = false;
        const unsafe: string[] = [];
        const s = await session(() => {
          // No exemption for a relay the supervisor ended: that is a stop that did not confirm clean, and it never installs.
          if (jobInFlight || reconciling || claimed > recorded || s.child.kills > 0) {
            unsafe.push(`jobInFlight=${jobInFlight} reconciling=${reconciling} pending=${claimed - recorded} kills=${s.child.kills}`);
          }
        });
        const { child, h, flush } = s;
        const stopSent = () => child.types().includes("stop");
        /** What the relay reports after every change: the full status, counts included. */
        const report = () => {
          if (!alive) return;
          child.emitMessage({
            type: "event",
            event: relayStatus({
              state: stopSent() ? "stopping" : "running",
              inFlight: jobInFlight,
              reconciliation: reconciling ? "pending" : "complete",
              counts: { claimed, sent: recorded, failed: 0, ambiguous: 0 },
            }),
          });
        };
        /** The relay child's own rule: it reports stopped only after it was told to stop, with no send open and nothing left to reconcile. */
        const relayStops = () => {
          if (!alive || !stopSent() || jobInFlight || reconciling) return;
          report();
          alive = false;
          child.emitMessage({ type: "stopped" });
          child.emitExit(0);
        };

        let request: Promise<void> | null = null;
        for (const op of ops) {
          switch (op) {
            case "claim":
              if (alive && !stopSent()) {
                claimed += 1;
                report();
              }
              break;
            case "jobStart":
              if (alive && !stopSent() && !jobInFlight && claimed > recorded) {
                jobInFlight = true;
                report();
              }
              break;
            case "jobFinish":
              if (alive && jobInFlight) {
                jobInFlight = false;
                recorded += 1;
                report();
              }
              break;
            case "reconcileStart":
              if (alive) { reconciling = true; report(); }
              break;
            case "reconcileEnd":
              if (alive) { reconciling = false; report(); }
              break;
            case "updateReady":
              ready = true;
              s.emit({ kind: "downloaded", version: VERSION });
              break;
            case "quit":
              request ??= s.coordinator.request();
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

        // The in-flight send finishes and reconciliation ends, and the relay is allowed to stop.
        // Entries that were claimed and never printed stay pending: a clean stop does not clear them.
        if (request) {
          for (let i = 0; i < 8 && alive; i += 1) {
            if (jobInFlight) {
              jobInFlight = false;
              recorded += 1;
              report();
            }
            reconciling = false;
            h.timers.fire("timeout");
            await flush();
            relayStops();
            await flush();
          }
          await request;
        }
        expect(unsafe).toEqual([]);

        const installs = s.installs();
        expect(installs).toBeLessThanOrEqual(1);
        if (request) {
          expect(s.coordinator.isQuitAllowed()).toBe(true);
          // Installing quits the app itself, so the app is never quit a second way.
          expect(installs + s.appQuit.mock.calls.length).toBe(1);
          // The install decision saw the pending count the relay last reported.
          for (const decision of s.decided) expect(decision.pending).toBe(claimed - recorded);
          const last = s.decided.at(-1);
          expect(installs).toBe(last && last.ready && !last.inFlight && last.pending === 0 && last.reconciliation === "complete" ? 1 : 0);
          // A stop wait that ended the relay quits without installing; the update is kept for the next clean quit.
          if (child.kills > 0) expect(installs).toBe(0);
          // That next clean quit, in a later launch where the cached update is found again, installs once.
          if (ready && installs === 0) expect(await laterCleanQuitInstalls()).toBe(1);
        } else {
          expect(installs).toBe(0);
        }
      }),
      propertyParams(150),
    );
  });

  it("a stop wait that expires during reconciliation quits without installing, and a later clean quit installs once", async () => {
    const s = await session();
    s.emit({ kind: "downloaded", version: VERSION });

    // The relay is still reconciling its spool: it reports neither a send in flight nor stopped. The wait expires.
    const request = s.coordinator.request();
    await Promise.resolve();
    s.h.timers.fire("timeout");
    await request;

    expect(s.child.kills).toBe(1);
    expect(s.installs()).toBe(0);
    expect(s.appQuit).toHaveBeenCalledTimes(1);
    expect(s.real.state()).toEqual({ kind: "ready", version: VERSION });
    expect(await laterCleanQuitInstalls()).toBe(1);
  });

  it("pending entries then a clean stop quit without installing, and a later clean quit with nothing pending installs once", async () => {
    const s = await session();
    s.emit({ kind: "downloaded", version: VERSION });
    // Two jobs were claimed and none has an outcome yet: the relay is idle (paused, or waiting for the printer).
    s.child.emitMessage({ type: "event", event: relayStatus({ inFlight: false, counts: { claimed: 2, sent: 0, failed: 0, ambiguous: 0 } }) });
    expect(s.h.controller.pendingEntries()).toBe(2);

    const request = s.coordinator.request();
    await s.flush();
    // The relay stops cleanly: nothing in flight, it says stopped itself, no kill.
    s.child.emitMessage({ type: "stopped" });
    s.child.emitExit(0);
    await request;

    expect(s.child.kills).toBe(0);
    expect(s.decided).toEqual([{ ready: true, inFlight: false, pending: 2, reconciliation: "complete" }]);
    expect(s.installs()).toBe(0);
    expect(s.appQuit).toHaveBeenCalledTimes(1);
    expect(s.real.state()).toEqual({ kind: "ready", version: VERSION });
    expect(await laterCleanQuitInstalls()).toBe(1);
  });

  it("counts claimed jobs that were sent, failed or left ambiguous as recorded", async () => {
    const s = await session();
    expect(s.h.controller.pendingEntries()).toBe(0);
    s.child.emitMessage({ type: "event", event: relayStatus({ counts: { claimed: 5, sent: 2, failed: 1, ambiguous: 1 } }) });
    expect(s.h.controller.pendingEntries()).toBe(1);
    s.child.emitMessage({ type: "event", event: relayStatus({ counts: { claimed: 5, sent: 3, failed: 1, ambiguous: 1 } }) });
    expect(s.h.controller.pendingEntries()).toBe(0);
  });
});


it.each(["pending", undefined, "unknown"])("a clean stop with unresolved reconciliation %s never installs", async (reconciliation) => {
  const s = await session();
  s.emit({ kind: "downloaded", version: VERSION });
  s.child.emitMessage({ type: "event", event: { ...relayStatus(), reconciliation } });
  const request = s.coordinator.request();
  await s.flush();
  s.child.emitMessage({ type: "stopped" });
  s.child.emitExit(0);
  await request;
  expect(s.installs()).toBe(0);
  expect(s.appQuit).toHaveBeenCalledTimes(1);
});

it("a jobs-settled callback cannot bypass a still-pending reconciliation signal", () => {
  const { adapter, emit, installs } = fakeAdapter();
  const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
  emit({ kind: "downloaded", version: VERSION });
  expect(updates.beforeQuit(false, 0, "pending")).toBe("defer");
  updates.jobsSettled(false, 0, "pending");
  expect(installs()).toBe(0);
  updates.jobsSettled(false, 0, "complete");
  expect(installs()).toBe(1);
});
