import { describe, expect, it } from "vitest";

import {
  FIVE_STATES,
  INITIAL_STATUS_STATE,
  RECOVERY_ACTIONS,
  evaluateFiveState,
  statusReducer,
  type FiveState,
  type StatusSignal,
  type StatusState,
} from "./statusReducer";

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

describe("statusReducer: table-driven state transitions", () => {
  // Helper to construct a baseline state for each of the 5 states
  const makeBaseline = (target: FiveState): StatusState => {
    switch (target) {
      case "Connected":
        return {
          state: "Connected",
          recoveryAction: RECOVERY_ACTIONS.Connected,
          printerAttached: true,
          enrolled: true,
          revoked: false,
          inUseElsewhere: false,
          cloud: "ok",
          relayState: "running",
          queue: "ready",
        };
      case "Unplugged":
        return {
          state: "Unplugged",
          recoveryAction: RECOVERY_ACTIONS.Unplugged,
          printerAttached: false,
          enrolled: true,
          revoked: false,
          inUseElsewhere: false,
          cloud: "ok",
          relayState: "running",
          queue: "ready",
        };
      case "Waiting":
        return {
          state: "Waiting",
          recoveryAction: RECOVERY_ACTIONS.Waiting,
          printerAttached: true,
          enrolled: true,
          revoked: false,
          inUseElsewhere: false,
          cloud: "unreachable",
          relayState: "running",
          queue: "ready",
        };
      case "Needs re-enrollment":
        return {
          state: "Needs re-enrollment",
          recoveryAction: RECOVERY_ACTIONS["Needs re-enrollment"],
          printerAttached: true,
          enrolled: false,
          revoked: false,
          inUseElsewhere: false,
          cloud: "ok",
          relayState: "running",
          queue: "ready",
        };
      case "In use elsewhere":
        return {
          state: "In use elsewhere",
          recoveryAction: RECOVERY_ACTIONS["In use elsewhere"],
          printerAttached: true,
          enrolled: true,
          revoked: false,
          inUseElsewhere: true,
          cloud: "ok",
          relayState: "running",
          queue: "ready",
        };
    }
  };

  type TransitionTestCase = {
    from: FiveState;
    signal: StatusSignal;
    expected: FiveState;
    description: string;
  };

  const transitions: TransitionTestCase[] = [
    // --- From Connected ---
    { from: "Connected", signal: { type: "printer_unplugged" }, expected: "Unplugged", description: "Connected -> Unplugged when cable pulled" },
    { from: "Connected", signal: { type: "cloud_unreachable" }, expected: "Waiting", description: "Connected -> Waiting when cloud drops" },
    { from: "Connected", signal: { type: "relay_restarting" }, expected: "Waiting", description: "Connected -> Waiting when relay restarts" },
    { from: "Connected", signal: { type: "relay_stopped" }, expected: "Waiting", description: "Connected -> Waiting when relay stops" },
    { from: "Connected", signal: { type: "queue_missing" }, expected: "Waiting", description: "Connected -> Waiting when CUPS queue missing" },
    { from: "Connected", signal: { type: "queue_disabled" }, expected: "Waiting", description: "Connected -> Waiting when CUPS queue disabled" },
    { from: "Connected", signal: { type: "cloud_revoked" }, expected: "Needs re-enrollment", description: "Connected -> Needs re-enrollment when token revoked" },
    { from: "Connected", signal: { type: "not_enrolled" }, expected: "Needs re-enrollment", description: "Connected -> Needs re-enrollment when unenrolled" },
    { from: "Connected", signal: { type: "printer_conflict", conflict: "serial_in_use" }, expected: "In use elsewhere", description: "Connected -> In use elsewhere when claimed by other Mac" },
    { from: "Connected", signal: { type: "cloud_ok" }, expected: "Connected", description: "Connected -> Connected on heartbeat ok" },

    // --- From Unplugged ---
    { from: "Unplugged", signal: { type: "printer_attached" }, expected: "Connected", description: "Unplugged -> Connected when printer plugged in and cloud ok" },
    { from: "Unplugged", signal: { type: "cloud_revoked" }, expected: "Needs re-enrollment", description: "Unplugged -> Needs re-enrollment on revocation (revocation outranks unplugged)" },
    { from: "Unplugged", signal: { type: "cloud_unreachable" }, expected: "Unplugged", description: "Unplugged -> Unplugged when cloud drops (unplugged outranks cloud unreachable)" },
    { from: "Unplugged", signal: { type: "printer_conflict", conflict: "serial_in_use" }, expected: "Unplugged", description: "Unplugged -> Unplugged when conflict reported but no printer" },

    // --- From Waiting ---
    { from: "Waiting", signal: { type: "cloud_ok" }, expected: "Connected", description: "Waiting -> Connected when cloud restores" },
    { from: "Waiting", signal: { type: "printer_unplugged" }, expected: "Unplugged", description: "Waiting -> Unplugged when printer detached" },
    { from: "Waiting", signal: { type: "cloud_revoked" }, expected: "Needs re-enrollment", description: "Waiting -> Needs re-enrollment on auth rejection" },
    { from: "Waiting", signal: { type: "printer_conflict", conflict: "serial_in_use" }, expected: "In use elsewhere", description: "Waiting -> In use elsewhere when conflicting claim" },
    { from: "Waiting", signal: { type: "relay_running" }, expected: "Waiting", description: "Waiting -> Waiting while cloud still unreachable" },

    // --- From Needs re-enrollment ---
    { from: "Needs re-enrollment", signal: { type: "enrolled" }, expected: "Connected", description: "Needs re-enrollment -> Connected on valid enrollment" },
    { from: "Needs re-enrollment", signal: { type: "printer_unplugged" }, expected: "Needs re-enrollment", description: "Needs re-enrollment -> Needs re-enrollment when unplugged (revocation outranks unplugged)" },
    { from: "Needs re-enrollment", signal: { type: "cloud_ok" }, expected: "Needs re-enrollment", description: "Needs re-enrollment -> Needs re-enrollment on cloud probe" },
    { from: "Needs re-enrollment", signal: { type: "printer_conflict", conflict: "serial_in_use" }, expected: "Needs re-enrollment", description: "Needs re-enrollment -> Needs re-enrollment on conflict (revocation outranks conflict)" },

    // --- From In use elsewhere ---
    { from: "In use elsewhere", signal: { type: "conflict_cleared" }, expected: "Connected", description: "In use elsewhere -> Connected when other laptop releases printer" },
    { from: "In use elsewhere", signal: { type: "printer_unplugged" }, expected: "Unplugged", description: "In use elsewhere -> Unplugged when disconnected" },
    { from: "In use elsewhere", signal: { type: "cloud_unreachable" }, expected: "In use elsewhere", description: "In use elsewhere -> In use elsewhere when network drops (conflict outranks network)" },
    { from: "In use elsewhere", signal: { type: "cloud_revoked" }, expected: "Needs re-enrollment", description: "In use elsewhere -> Needs re-enrollment when credentials revoked" },

    // --- Self-transitions (stay in same state) ---
    { from: "Connected", signal: { type: "relay_running" }, expected: "Connected", description: "Connected -> Connected (running signal)" },
    { from: "Unplugged", signal: { type: "printer_unplugged" }, expected: "Unplugged", description: "Unplugged -> Unplugged (duplicate unplug)" },
    { from: "Waiting", signal: { type: "relay_starting" }, expected: "Waiting", description: "Waiting -> Waiting (still starting)" },
    { from: "Waiting", signal: { type: "relay_stopped" }, expected: "Waiting", description: "Waiting -> Waiting (relay stopped)" },
    { from: "Waiting", signal: { type: "queue_disabled" }, expected: "Waiting", description: "Waiting -> Waiting (queue disabled)" },
    { from: "Needs re-enrollment", signal: { type: "not_enrolled" }, expected: "Needs re-enrollment", description: "Needs re-enrollment -> Needs re-enrollment (not enrolled)" },
    { from: "In use elsewhere", signal: { type: "printer_conflict", conflict: "serial_in_use" }, expected: "In use elsewhere", description: "In use elsewhere -> In use elsewhere (duplicate conflict)" },
  ];

  it.each(transitions)("$description", ({ from, signal, expected }) => {
    const startState = makeBaseline(from);
    expect(startState.state).toBe(from);

    const nextState = statusReducer(startState, signal);
    expect(nextState.state).toBe(expected);
    expect(nextState.recoveryAction).toBe(RECOVERY_ACTIONS[expected]);
  });

  it("covers transitions between every pair of distinct states", () => {
    // Verify that every state appears as a source and destination
    const sources = new Set(transitions.map((t) => t.from));
    const destinations = new Set(transitions.map((t) => t.expected));
    for (const state of FIVE_STATES) {
      expect(sources).toContain(state);
      expect(destinations).toContain(state);
    }
  });

  it("handles a sequence of signals via Array.prototype.reduce", () => {
    const signals: StatusSignal[] = [
      { type: "enrolled" },
      { type: "printer_attached" },
      { type: "queue_ready" },
      { type: "relay_running" },
      { type: "cloud_ok" },
    ];

    const finalState = signals.reduce(statusReducer, INITIAL_STATUS_STATE);
    expect(finalState.state).toBe("Connected");
    expect(finalState.recoveryAction).toBe(RECOVERY_ACTIONS.Connected);
  });
});

describe("evaluateFiveState priority ordering", () => {
  it("prioritizes revocation above everything else", () => {
    expect(
      evaluateFiveState({
        printerAttached: false,
        enrolled: false,
        revoked: true,
        inUseElsewhere: true,
        cloud: "revoked",
        relayState: "stopped",
        queue: "missing",
      }),
    ).toBe("Needs re-enrollment");
  });

  it("prioritizes unplugged above conflict and network", () => {
    expect(
      evaluateFiveState({
        printerAttached: false,
        enrolled: true,
        revoked: false,
        inUseElsewhere: true,
        cloud: "unreachable",
        relayState: "stopped",
        queue: "missing",
      }),
    ).toBe("Unplugged");
  });

  it("prioritizes in use elsewhere above waiting/unreachable", () => {
    expect(
      evaluateFiveState({
        printerAttached: true,
        enrolled: true,
        revoked: false,
        inUseElsewhere: true,
        cloud: "unreachable",
        relayState: "running",
        queue: "ready",
      }),
    ).toBe("In use elsewhere");
  });

  it("evaluates to Waiting when cloud or relay is not ready", () => {
    expect(
      evaluateFiveState({
        printerAttached: true,
        enrolled: true,
        revoked: false,
        inUseElsewhere: false,
        cloud: "unreachable",
        relayState: "running",
        queue: "ready",
      }),
    ).toBe("Waiting");
  });

  it("evaluates to Connected when all prerequisites pass", () => {
    expect(
      evaluateFiveState({
        printerAttached: true,
        enrolled: true,
        revoked: false,
        inUseElsewhere: false,
        cloud: "ok",
        relayState: "running",
        queue: "ready",
      }),
    ).toBe("Connected");
  });
});
