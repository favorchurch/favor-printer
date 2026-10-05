import { describe, expect, it } from "vitest";

import type { QueueState, StatusColor, UpdateState } from "../../shared";
import type { CloudState, RelayState, RelayStatus } from "../../../../vendor/relay/status";
import { deriveStatus, recentJobs, REVOKED_HEADLINE, type StatusInputs } from "./statusSummary";

const relay = (overrides: Partial<RelayStatus> = {}): RelayStatus => ({
  state: "running",
  cloud: "ok",
  printerIds: ["printer-1"],
  inFlight: false,
  counts: { claimed: 0, sent: 0, failed: 0, ambiguous: 0 },
  lastJobAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  ...overrides,
});

const inputs = (overrides: Partial<StatusInputs> = {}): StatusInputs => ({
  enrolled: true,
  revoked: false,
  legacyRelayLoaded: false,
  relay: relay(),
  relayRestarting: false,
  printerAttached: true,
  queue: "ready",
  paused: false,
  update: { kind: "idle" },
  ...overrides,
});

describe("deriveStatus colors", () => {
  const cases: Array<[string, Partial<StatusInputs>, StatusColor]> = [
    ["enrolled, cloud ok, queue ready", {}, "green"],
    ["not enrolled", { enrolled: false, relay: null }, "amber"],
    ["legacy relay loaded", { legacyRelayLoaded: true, relay: null }, "amber"],
    ["relay restarting", { relayRestarting: true, relay: null }, "amber"],
    ["no printer", { printerAttached: false }, "amber"],
    ["queue missing", { queue: "missing" }, "amber"],
    ["queue disabled", { queue: "disabled" }, "amber"],
    ["relay not running", { relay: null }, "amber"],
    ["relay starting", { relay: relay({ state: "starting" }) }, "amber"],
    ["relay stopping", { relay: relay({ state: "stopping" }) }, "amber"],
    ["relay stopped", { relay: relay({ state: "stopped" }) }, "amber"],
    ["cloud unreachable", { relay: relay({ cloud: "unreachable" }) }, "amber"],
    ["paused by the volunteer", { paused: true }, "amber"],
    ["relay paused", { relay: relay({ state: "paused" }) }, "amber"],
    ["update downloading", { update: { kind: "downloading" } }, "amber"],
    ["update checking", { update: { kind: "checking" } }, "green"],
    ["update ready", { update: { kind: "ready", version: "0.2.0" } }, "green"],
    ["update failed", { update: { kind: "error" } }, "green"],
    ["revoked flag", { revoked: true }, "red"],
    ["cloud says revoked", { relay: relay({ cloud: "revoked" }) }, "red"],
  ];

  it.each(cases)("%s is %s", (_name, overrides, color) => {
    expect(deriveStatus(inputs(overrides)).color).toBe(color);
  });
});

describe("deriveStatus copy", () => {
  it("shows the removed-laptop message in red", () => {
    expect(deriveStatus(inputs({ revoked: true }))).toEqual({
      color: "red",
      headline: "This laptop was removed. Ask an admin for a new code.",
      detail: null,
    });
    expect(REVOKED_HEADLINE).toBe("This laptop was removed. Ask an admin for a new code.");
  });

  it("is ready when everything is on", () => {
    expect(deriveStatus(inputs())).toEqual({ color: "green", headline: "Ready to print", detail: null });
  });

  it("gives every non-green state a next step or a plain reason", () => {
    for (const [name, overrides, color] of [
      ["not enrolled", { enrolled: false, relay: null }, "amber"],
      ["no printer", { printerAttached: false }, "amber"],
      ["queue missing", { queue: "missing" }, "amber"],
      ["queue disabled", { queue: "disabled" }, "amber"],
      ["unreachable", { relay: relay({ cloud: "unreachable" }) }, "amber"],
      ["paused", { paused: true }, "amber"],
      ["legacy", { legacyRelayLoaded: true, relay: null }, "amber"],
    ] as Array<[string, Partial<StatusInputs>, StatusColor]>) {
      const summary = deriveStatus(inputs(overrides));
      expect(summary.color, name).toBe(color);
      expect(summary.headline.length, name).toBeGreaterThan(0);
      expect(summary.detail, name).not.toBeNull();
    }
  });

  it("warns on green when the last label is in doubt, and when it failed", () => {
    expect(deriveStatus(inputs({ relay: relay({ lastError: "send_ambiguous" }) })).detail).toMatch(/label stock/i);
    expect(deriveStatus(inputs({ relay: relay({ lastError: "send_failed" }) })).detail).toMatch(/failed/i);
  });

  it("mentions a ready update", () => {
    expect(deriveStatus(inputs({ update: { kind: "ready", version: "0.2.0" } })).detail).toMatch(/quit/i);
  });
});

describe("deriveStatus priority", () => {
  it("puts a removed laptop above every other problem", () => {
    const summary = deriveStatus(
      inputs({ revoked: true, legacyRelayLoaded: true, enrolled: false, printerAttached: false, queue: "missing", paused: true }),
    );
    expect(summary.color).toBe("red");
  });

  it("puts the legacy relay above setup, because nothing may start until it is gone", () => {
    expect(deriveStatus(inputs({ legacyRelayLoaded: true, enrolled: false })).headline).toMatch(/old print relay/i);
  });

  it("names the printer before the cloud when both are down", () => {
    const summary = deriveStatus(inputs({ printerAttached: false, relay: relay({ cloud: "unreachable" }) }));
    expect(summary.headline).toMatch(/no printer/i);
  });
});

describe("deriveStatus is green only when everything is on", () => {
  const bool = [false, true];
  const queues: QueueState[] = ["ready", "missing", "disabled"];
  const relayStates: RelayState[] = ["starting", "running", "paused", "stopping", "stopped"];
  const clouds: CloudState[] = ["ok", "unreachable", "revoked"];
  const updates: UpdateState[] = [
    { kind: "idle" },
    { kind: "checking" },
    { kind: "downloading" },
    { kind: "ready", version: "0.2.0" },
    { kind: "error" },
  ];

  it("checks every combination", () => {
    let checked = 0;
    for (const enrolled of bool)
      for (const revoked of bool)
        for (const legacyRelayLoaded of bool)
          for (const relayRestarting of bool)
            for (const printerAttached of bool)
              for (const paused of bool)
                for (const queue of queues)
                  for (const state of relayStates)
                    for (const cloud of clouds)
                      for (const update of updates) {
                        const summary = deriveStatus({
                          enrolled,
                          revoked,
                          legacyRelayLoaded,
                          relay: relay({ state, cloud }),
                          relayRestarting,
                          printerAttached,
                          queue,
                          paused,
                          update,
                        });
                        checked += 1;
                        const mustBeRed = revoked || cloud === "revoked";
                        const allOn =
                          !mustBeRed &&
                          !legacyRelayLoaded &&
                          enrolled &&
                          !relayRestarting &&
                          printerAttached &&
                          queue === "ready" &&
                          state === "running" &&
                          cloud === "ok" &&
                          !paused &&
                          update.kind !== "downloading";
                        const expected: StatusColor = mustBeRed ? "red" : allOn ? "green" : "amber";
                        expect(summary.color).toBe(expected);
                        expect(summary.headline.length).toBeGreaterThan(0);
                      }
    expect(checked).toBe(2 ** 6 * 3 * 5 * 3 * 5);
  });
});

describe("recentJobs", () => {
  it("passes counts only", () => {
    expect(recentJobs(relay({ counts: { claimed: 9, sent: 5, failed: 1, ambiguous: 2 } }))).toEqual({
      sent: 5,
      failed: 1,
      ambiguous: 2,
    });
  });

  it("is zero while the relay is not running", () => {
    expect(recentJobs(null)).toEqual({ sent: 0, failed: 0, ambiguous: 0 });
  });
});
