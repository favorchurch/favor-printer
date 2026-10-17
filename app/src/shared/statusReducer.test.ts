import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  FIVE_STATES,
  INITIAL_STATUS_STATE,
  RECOVERY_ACTIONS,
  evaluateFiveState,
  statusReducer,
  INITIAL_PRINTER_PRESENCE,
  PRINTER_PRESENCE_FAILURE_LIMIT,
  printerPresenceReducer,
  type FiveState,
  type StatusSignal,
  type StatusState,
} from "./statusReducer";
import { propertyParams } from "./testing/property";

describe("statusReducer: five states and recovery actions", () => {
  it("defines exactly the five states", () => {
    expect(FIVE_STATES).toEqual([
      "Connected",
      "Unplugged",
      "Waiting",
      "Needs re-enrollment",
      "In use elsewhere",
    ]);
    expect(FIVE_STATES).toHaveLength(5);
  });

  it("assigns exactly one recovery action to each state with product name and zero em dashes", () => {
    for (const state of FIVE_STATES) {
      const action = RECOVERY_ACTIONS[state];
      expect(typeof action).toBe("string");
      expect(action.length).toBeGreaterThan(10);
      expect(action).not.toContain("—");
      expect(action).not.toContain("--");
    }
    // Favor Printer / Favor RSVP product naming
    expect(RECOVERY_ACTIONS.Connected).toContain("Favor Printer");
    expect(RECOVERY_ACTIONS.Waiting).toContain("Favor RSVP");
    expect(RECOVERY_ACTIONS["Needs re-enrollment"]).toContain("Favor RSVP");
  });

  it("is a pure function that never mutates its input state", () => {
    const input: StatusState = { ...INITIAL_STATUS_STATE };
    const frozen = Object.freeze({ ...input });
    const result = statusReducer(frozen, { type: "printer_attached" });
    expect(result).not.toBe(frozen);
    expect(result.printerAttached).toBe(true);
    expect(frozen.printerAttached).toBe(false);
  });
});

describe("printerPresenceReducer", () => {
  it("tracks successful attach, unplug and replug scans with the last seen time", () => {
    const seen = printerPresenceReducer(INITIAL_PRINTER_PRESENCE, {
      type: "printer_found",
      seenAt: "2026-10-17T00:00:00.000Z",
    });
    expect(seen).toEqual({ presence: "attached", lastSeenAt: "2026-10-17T00:00:00.000Z", consecutiveFailures: 0 });
    const unplugged = printerPresenceReducer(seen, {
      type: "printer_absent",
    });
    expect(unplugged).toEqual({ presence: "detached", lastSeenAt: seen.lastSeenAt, consecutiveFailures: 0 });
    expect(
      printerPresenceReducer(unplugged, {
        type: "printer_found",
        seenAt: "2026-10-17T00:02:00.000Z",
      }),
    ).toEqual({ presence: "attached", lastSeenAt: "2026-10-17T00:02:00.000Z", consecutiveFailures: 0 });
  });

  it("keeps one transient failure, then expires stale presence to unknown", () => {
    const attached = printerPresenceReducer(INITIAL_PRINTER_PRESENCE, {
      type: "printer_found",
      seenAt: "2026-10-17T00:00:00.000Z",
    });
    const firstFailure = printerPresenceReducer(attached, { type: "listing_failed" });
    expect(firstFailure.presence).toBe("attached");
    expect(printerPresenceReducer(firstFailure, { type: "listing_failed" })).toMatchObject({
      presence: "unknown",
      lastSeenAt: attached.lastSeenAt,
      consecutiveFailures: PRINTER_PRESENCE_FAILURE_LIMIT,
    });
  });

  it("never assumes a printer is attached before a successful scan", () => {
    expect(printerPresenceReducer(INITIAL_PRINTER_PRESENCE, { type: "listing_failed" }).presence).toBe("unknown");
  });
});

const signalArb: fc.Arbitrary<StatusSignal> = fc.oneof(
  fc.constantFrom<StatusSignal>(
    { type: "printer_attached" },
    { type: "printer_unplugged" },
    { type: "queue_ready" },
    { type: "queue_missing" },
    { type: "queue_disabled" },
    { type: "relay_running" },
    { type: "relay_starting" },
    { type: "relay_restarting" },
    { type: "relay_stopped" },
    { type: "cloud_ok" },
    { type: "cloud_unreachable" },
    { type: "cloud_revoked" },
    { type: "printer_conflict", conflict: "serial_in_use" },
    { type: "conflict_cleared" },
    { type: "enrolled" },
    { type: "not_enrolled" },
  ),
  fc.string().map((conflict): StatusSignal => ({ type: "printer_conflict", conflict })),
);

const signalsArb = fc.array(signalArb, { maxLength: 40 });
/**
 * INITIAL_STATUS_STATE says Waiting although its flags evaluate to Needs re-enrollment,
 * so the invariants below hold from the first signal on.
 */
const startedArb = fc.array(signalArb, { minLength: 1, maxLength: 40 });

const contextArb = fc.record({
  printerAttached: fc.boolean(),
  enrolled: fc.boolean(),
  revoked: fc.boolean(),
  inUseElsewhere: fc.boolean(),
  cloud: fc.constantFrom("ok", "unreachable", "revoked" as const),
  relayState: fc.constantFrom("starting", "running", "restarting", "stopped" as const),
  queue: fc.constantFrom("ready", "missing", "disabled" as const),
});

const run = (signals: StatusSignal[], from: StatusState = INITIAL_STATUS_STATE) => signals.reduce(statusReducer, from);


describe("statusReducer properties", () => {
  it("is total: every signal sequence lands in one of the five states with its recovery action", () => {
    fc.assert(
      fc.property(signalsArb, (signals) => {
        let state = INITIAL_STATUS_STATE;
        for (const signal of signals) {
          state = statusReducer(state, signal);
          expect(FIVE_STATES).toContain(state.state);
          expect(state.recoveryAction).toBe(RECOVERY_ACTIONS[state.state]);
          expect(state.state).toBe(evaluateFiveState(state));
        }
      }),
      propertyParams(),
    );
  });

  it("never mutates the state it is given", () => {
    fc.assert(
      fc.property(signalsArb, signalArb, (signals, signal) => {
        const before = run(signals);
        const snapshot = structuredClone(before);
        statusReducer(Object.freeze(before), signal);
        expect(before).toEqual(snapshot);
      }),
      propertyParams(),
    );
  });

  it("is Connected exactly when enrolled, plugged in, unclaimed, and relay, cloud and queue are all up", () => {
    fc.assert(
      fc.property(signalsArb, (signals) => {
        const last = (types: StatusSignal["type"][]) => signals.findLast((signal) => types.includes(signal.type))?.type;
        const lastConflict = signals.findLast(
          (signal) => signal.type === "conflict_cleared" || (signal.type === "printer_conflict" && signal.conflict === "serial_in_use"),
        );
        const healthy =
          last(["enrolled", "not_enrolled"]) === "enrolled" &&
          last(["cloud_ok", "cloud_unreachable", "cloud_revoked"]) === "cloud_ok" &&
          last(["printer_attached", "printer_unplugged"]) === "printer_attached" &&
          last(["relay_running", "relay_starting", "relay_restarting", "relay_stopped"]) === "relay_running" &&
          last(["queue_ready", "queue_missing", "queue_disabled"]) === "queue_ready" &&
          lastConflict?.type !== "printer_conflict";
        expect(run(signals).state === "Connected").toBe(healthy);
      }),
      propertyParams(),
    );
  });

  it("stays in Needs re-enrollment after a revocation until cloud_ok or enrolled", () => {
    const notRecovery = signalArb.filter((signal) => signal.type !== "cloud_ok" && signal.type !== "enrolled");
    fc.assert(
      fc.property(signalsArb, fc.array(notRecovery, { maxLength: 40 }), (before, after) => {
        let state = statusReducer(run(before), { type: "cloud_revoked" });
        for (const signal of after) {
          expect(state.state).toBe("Needs re-enrollment");
          state = statusReducer(state, signal);
        }
        expect(state.state).toBe("Needs re-enrollment");
      }),
      propertyParams(),
    );
  });

  it("leaves Needs re-enrollment for Connected once the cloud accepts the laptop again", () => {
    const recovery: StatusSignal[] = [
      { type: "cloud_ok" },
      { type: "printer_attached" },
      { type: "queue_ready" },
      { type: "relay_running" },
      { type: "conflict_cleared" },
    ];
    fc.assert(
      fc.property(signalsArb, (before) => {
        expect(run([...before, { type: "enrolled" }, { type: "cloud_revoked" }, ...recovery]).state).toBe("Connected");
      }),
      propertyParams(),
    );
  });

  it("stays in Needs re-enrollment after not_enrolled until enrolled", () => {
    fc.assert(
      fc.property(signalsArb, fc.array(signalArb.filter((signal) => signal.type !== "enrolled"), { maxLength: 40 }), (before, after) => {
        expect(run([{ type: "not_enrolled" }, ...after], run(before)).state).toBe("Needs re-enrollment");
      }),
      propertyParams(),
    );
  });

  it("is Unplugged or Needs re-enrollment after an unplug until the printer is attached again", () => {
    fc.assert(
      fc.property(signalsArb, fc.array(signalArb.filter((signal) => signal.type !== "printer_attached"), { maxLength: 40 }), (before, after) => {
        expect(["Unplugged", "Needs re-enrollment"]).toContain(run([{ type: "printer_unplugged" }, ...after], run(before)).state);
      }),
      propertyParams(),
    );
  });

  it("ignores conflicts other than serial_in_use", () => {
    fc.assert(
      fc.property(startedArb, fc.string().filter((conflict) => conflict !== "serial_in_use"), (signals, conflict) => {
        const before = run(signals);
        expect(statusReducer(before, { type: "printer_conflict", conflict })).toEqual(before);
      }),
      propertyParams(),
    );
  });
});

describe("printerPresenceReducer properties", () => {
  it("keeps presence and lastSeenAt consistent across scan histories", () => {
    const signalArb = fc.oneof(
      fc.constant({ type: "listing_failed" } as const),
      fc.constant({ type: "printer_absent" } as const),
      fc.constant({ type: "printer_found", seenAt: "2026-10-17T00:00:00.000Z" } as const),
    );
    fc.assert(
      fc.property(fc.array(signalArb, { maxLength: 60 }), (signals) => {
        const state = signals.reduce(printerPresenceReducer, INITIAL_PRINTER_PRESENCE);
        expect(state.consecutiveFailures).toBeGreaterThanOrEqual(0);
        if (state.presence === "attached") expect(state.lastSeenAt).not.toBeNull();
        if (state.presence === "unknown" && state.consecutiveFailures === 0) expect(state.lastSeenAt).toBeNull();
        if (state.consecutiveFailures >= PRINTER_PRESENCE_FAILURE_LIMIT) expect(state.presence).toBe("unknown");
      }),
      propertyParams(),
    );
  });
});

describe("evaluateFiveState priority", () => {
  it("ranks re-enrollment over unplugged over in use elsewhere over waiting", () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const expected: FiveState =
          context.revoked || !context.enrolled || context.cloud === "revoked"
            ? "Needs re-enrollment"
            : !context.printerAttached
              ? "Unplugged"
              : context.inUseElsewhere
                ? "In use elsewhere"
                : context.cloud === "ok" && context.relayState === "running" && context.queue === "ready"
                  ? "Connected"
                  : "Waiting";
        expect(evaluateFiveState(context)).toBe(expected);
      }),
      propertyParams(),
    );
  });
});
