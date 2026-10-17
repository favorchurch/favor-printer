import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { evaluateFiveState, RECOVERY_ACTIONS, type QueueState, type StatusColor, type UpdateState } from "../../shared";
import { propertyParams } from "../../shared/testing/property";
import type { CloudState, RelayState, RelayStatus } from "../../../../vendor/relay/status";
import { deriveFiveState, deriveStatus, FIVE_STATE_HEADLINES, recentJobs, REVOKED_HEADLINE, type StatusInputs } from "./statusSummary";

const relay = (overrides: Partial<RelayStatus> = {}): RelayStatus => ({
  state: "running",
  cloud: "ok",
  printerIds: ["printer-1"],
  handedOverPrinterIds: [],
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

describe("deriveStatus copy", () => {
  it("uses the five-state headline for the removed laptop", () => {
    expect(deriveStatus(inputs({ revoked: true }))).toEqual({
      color: "red",
      headline: "Needs re-enrollment",
      detail: null,
    });
    expect(REVOKED_HEADLINE).toBe("This laptop was removed. Ask an admin for a new code.");
  });

  it("is ready when everything is on", () => {
    expect(deriveStatus(inputs())).toEqual({ color: "green", headline: "Connected", detail: null });
  });

  it("keeps unknown printer presence out of the ready state", () => {
    expect(deriveStatus(inputs({ printerPresence: "unknown" }))).toEqual({
      color: "amber",
      headline: "Waiting for connection",
      detail: "Printer presence will update after the next scan.",
    });
  });

  it("uses the dedicated headline when another laptop has claimed the printer", () => {
    expect(deriveStatus(inputs({ inUseElsewhere: true })).headline).toBe("Printer in use elsewhere");
  });

  it("warns on green when the last label is in doubt, and when it failed", () => {
    expect(deriveStatus(inputs({ relay: relay({ lastError: "send_ambiguous" }) })).detail).toMatch(/label stock/i);
    expect(deriveStatus(inputs({ relay: relay({ lastError: "send_failed" }) })).detail).toMatch(/failed/i);
  });

  it("says the printer moved when the relay was handed over", () => {
    const summary = deriveStatus(inputs({ relay: relay({ handedOverPrinterIds: ["printer-1"], printerIds: [] }) }));
    expect(summary.color).toBe("amber");
    expect(summary.headline).toBe("Connected");
  });

  it("mentions a ready update", () => {
    expect(deriveStatus(inputs({ update: { kind: "ready", version: "0.2.0" } })).detail).toMatch(/quit/i);
  });

  it("maps all five reducer states to the approved status headlines", () => {
    expect(FIVE_STATE_HEADLINES).toEqual({
      Connected: "Connected",
      Unplugged: "Printer unplugged",
      Waiting: "Waiting for connection",
      "Needs re-enrollment": "Needs re-enrollment",
      "In use elsewhere": "Printer in use elsewhere",
    });
  });

  // docs/design/tray-spec.md section 2, row by row, word for word.
  it.each([
    ["revoked", { revoked: true }, "red", "Needs re-enrollment", null],
    ["revoked by the cloud", { relay: relay({ cloud: "revoked" }) }, "red", "Needs re-enrollment", null],
    ["legacy", { legacyRelayLoaded: true }, "amber", "Waiting for connection", "Move to Favor Printer to start printing."],
    ["not enrolled", { enrolled: false, relay: null }, "amber", "Needs re-enrollment", "Enter the six-digit code from an admin."],
    ["restarting", { relayRestarting: true }, "amber", "Waiting for connection", "Printing resumes in a moment."],
    ["no printer", { printerAttached: false }, "amber", "Printer unplugged", "Plug in the Zebra with its USB cable."],
    ["queue missing", { queue: "missing" }, "amber", "Waiting for connection", "Choose Set up printer to continue."],
    [
      "queue disabled",
      { queue: "disabled" },
      "amber",
      "Waiting for connection",
      "Turn it back on in System Settings, under Printers & Scanners.",
    ],
    ["relay stopped", { relay: null }, "amber", "Waiting for connection", null],
    ["relay starting", { relay: relay({ state: "starting" }) }, "amber", "Waiting for connection", null],
    ["unreachable", { relay: relay({ cloud: "unreachable" }) }, "amber", "Waiting for connection", "Printing resumes when the internet is back."],
    ["paused", { paused: true }, "amber", "Connected", "Choose Resume printing in the menu."],
    ["relay paused", { relay: relay({ state: "paused" }) }, "amber", "Waiting for connection", "Choose Resume printing in the menu."],
    ["downloading", { update: { kind: "downloading" } }, "amber", "Connected", null],
    [
      "ambiguous",
      { relay: relay({ lastError: "send_ambiguous" }) },
      "green",
      "Connected",
      "The last label may not have printed. Check the label stock.",
    ],
    ["failed", { relay: relay({ lastError: "send_failed" }) }, "green", "Connected", "The last label failed to print."],
    ["update ready", { update: { kind: "ready", version: "0.2.0" } }, "green", "Connected", "An update installs when you quit."],
    ["healthy", {}, "green", "Connected", null],
  ] as Array<[string, Partial<StatusInputs>, StatusColor, string, string | null]>)(
    "matches the copy deck when %s",
    (_name, overrides, color, headline, detail) => {
      const summary = deriveStatus(inputs(overrides));
      expect(summary).toEqual({ color, headline, detail });
      expect(`${summary.headline} ${summary.detail ?? ""}`).not.toMatch(/—/);
    },
  );
});

describe("deriveStatus priority", () => {
  it("puts a removed laptop above every other problem", () => {
    const summary = deriveStatus(
      inputs({ revoked: true, legacyRelayLoaded: true, enrolled: false, printerAttached: false, queue: "missing", paused: true }),
    );
    expect(summary.color).toBe("red");
  });

  it("puts the legacy relay above setup, because nothing may start until it is gone", () => {
    expect(deriveStatus(inputs({ legacyRelayLoaded: true, enrolled: false })).headline).toBe("Needs re-enrollment");
  });

  it("names the printer before the cloud when both are down", () => {
    const summary = deriveStatus(inputs({ printerAttached: false, relay: relay({ cloud: "unreachable" }) }));
    expect(summary.headline).toBe("Printer unplugged");
  });
});

const relayArb = fc.option(
  fc.record({
    state: fc.constantFrom<RelayState[]>("starting", "running", "paused", "stopping", "stopped"),
    cloud: fc.constantFrom<CloudState[]>("ok", "unreachable", "revoked"),
    lastError: fc.constantFrom(null, "send_failed", "send_ambiguous"),
  }).map((overrides) => relay(overrides)),
  { nil: null },
);

const inputsArb: fc.Arbitrary<StatusInputs> = fc.record({
  enrolled: fc.boolean(),
  revoked: fc.boolean(),
  legacyRelayLoaded: fc.boolean(),
  relay: relayArb,
  relayRestarting: fc.boolean(),
  printerAttached: fc.boolean(),
  queue: fc.constantFrom<QueueState[]>("ready", "missing", "disabled"),
  paused: fc.boolean(),
  update: fc.constantFrom<UpdateState[]>(
    { kind: "idle" },
    { kind: "checking" },
    { kind: "downloading" },
    { kind: "ready", version: "0.2.0" },
    { kind: "error" },
  ),
  inUseElsewhere: fc.boolean(),
});

describe("deriveStatus properties", () => {
  it("is red when revoked, green only when everything is on, and amber otherwise", () => {
    fc.assert(
      fc.property(inputsArb, (input) => {
        const summary = deriveStatus(input);
        const red = input.revoked || input.relay?.cloud === "revoked";
        const allOn =
          !input.legacyRelayLoaded &&
          input.enrolled &&
          !input.relayRestarting &&
          input.printerAttached &&
          input.queue === "ready" &&
          input.relay?.state === "running" &&
          input.relay.cloud === "ok" &&
          !input.paused &&
          input.update.kind !== "downloading";
        expect(summary.color).toBe(red ? "red" : allOn ? "green" : "amber");
        expect(summary.headline.length).toBeGreaterThan(0);
        expect(`${summary.headline} ${summary.detail ?? ""}`).not.toMatch(/—/);
      }),
      propertyParams(),
    );
  });

  it("agrees with the five-state model: red is Needs re-enrollment, green is Connected unless the printer is claimed elsewhere", () => {
    fc.assert(
      fc.property(inputsArb, (input) => {
        const { color } = deriveStatus(input);
        const { state } = deriveFiveState(input);
        if (color === "red") expect(state).toBe("Needs re-enrollment");
        if (color === "green") expect(state).toBe(input.inUseElsewhere ? "In use elsewhere" : "Connected");
      }),
      propertyParams(),
    );
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

describe("deriveFiveState", () => {
  it("is evaluateFiveState over the relay's view, with its recovery action", () => {
    fc.assert(
      fc.property(inputsArb, (input) => {
        const { relay: status } = input;
        const state = evaluateFiveState({
          printerAttached: input.printerAttached,
          enrolled: input.enrolled,
          revoked: input.revoked,
          inUseElsewhere: Boolean(input.inUseElsewhere),
          cloud: input.revoked || status?.cloud === "revoked" ? "revoked" : (status?.cloud ?? "unreachable"),
          relayState: input.relayRestarting
            ? "restarting"
            : status?.state === "running" || status?.state === "starting"
              ? status.state
              : "stopped",
          queue: input.queue,
        });
        expect(deriveFiveState(input)).toEqual({
          state,
          headline: FIVE_STATE_HEADLINES[state],
          recoveryAction: RECOVERY_ACTIONS[state],
        });
      }),
      propertyParams(),
    );
  });

  it("uses the copy deck's recovery actions", () => {
    expect(deriveFiveState(inputs()).recoveryAction).toBe("Run a local test print in Favor Printer to verify labels.");
    expect(deriveFiveState(inputs({ inUseElsewhere: true })).recoveryAction).toBe(
      "Ask an admin to disconnect this printer from the other laptop.",
    );
  });
});
