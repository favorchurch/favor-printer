/**
 * Turns relay, cloud, printer, update and pause state into the tray colour and
 * copy. The first matching rule wins, so the order below is the priority:
 * a removed laptop outranks everything, and green needs every light on.
 */

import {
  evaluateFiveState,
  RECOVERY_ACTIONS,
  type FiveState,
  type JobCounts,
  type QueueState,
  type StatusSummary,
  type UpdateState,
  type PrinterPresence,
} from "../../shared";
import type { RelayStatus } from "../../../../vendor/relay/status";

export const REVOKED_HEADLINE = "This laptop was removed. Ask an admin for a new code.";

export type StatusInputs = {
  enrolled: boolean;
  /** The saved token was rejected. Kept after the relay stops, until the volunteer enrolls again. */
  revoked: boolean;
  legacyRelayLoaded: boolean;
  /** Null while the relay process is not running. */
  relay: RelayStatus | null;
  /** The supervisor is waiting to restart a crashed relay. */
  relayRestarting: boolean;
  printerAttached: boolean;
  printerPresence?: PrinterPresence;
  queue: QueueState;
  paused: boolean;
  update: UpdateState;
  /** Another laptop has claimed this printer. */
  inUseElsewhere?: boolean;
};

const amber = (headline: string, detail: string | null): StatusSummary => ({ color: "amber", headline, detail });

function deriveOperationalStatus(inputs: StatusInputs): StatusSummary {
  const { relay } = inputs;

  if (inputs.revoked || relay?.cloud === "revoked") {
    return { color: "red", headline: REVOKED_HEADLINE, detail: null };
  }
  if (inputs.legacyRelayLoaded) {
    return amber("The old print relay is still running", "Move to Favor Printer to start printing.");
  }
  if (!inputs.enrolled) return amber("Not set up yet", "Enter the six-digit code from an admin.");
  if (inputs.relayRestarting) return amber("Print relay is restarting", "Printing resumes in a moment.");
  if (inputs.printerPresence === "unknown") {
    return amber("Waiting for connection", "Printer presence will update after the next scan.");
  }
  if (!inputs.printerAttached) return amber("No printer found", "Plug in the Zebra with its USB cable.");
  if (inputs.queue === "missing") return amber("Printer needs setting up", "Choose Set up printer to continue.");
  if (inputs.queue === "disabled") {
    return amber("Printer is turned off", "Turn it back on in System Settings, under Printers & Scanners.");
  }
  if (!relay || relay.state === "starting" || relay.state === "stopped" || relay.state === "stopping") {
    return amber("Starting up", null);
  }
  if (relay.cloud === "unreachable") {
    return amber("Cannot reach Favor RSVP", "Printing resumes when the internet is back.");
  }
  if (relay.handedOverPrinterIds.length > 0) {
    return amber("Printer moved to another host", "Ask an RSVP admin if this laptop should print again.");
  }
  if (inputs.paused || relay.state === "paused") {
    return amber("Printing is paused", "Choose Resume printing in the menu.");
  }
  if (inputs.update.kind === "downloading") return amber("Updating Favor Printer", null);

  if (relay.lastError === "send_ambiguous") {
    return {
      color: "green",
      headline: "Ready to print",
      detail: "The last label may not have printed. Check the label stock.",
    };
  }
  if (relay.lastError === "send_failed") {
    return { color: "green", headline: "Ready to print", detail: "The last label failed to print." };
  }
  if (inputs.update.kind === "ready") {
    return { color: "green", headline: "Ready to print", detail: "An update installs when you quit." };
  }
  return { color: "green", headline: "Ready to print", detail: null };
}

export function deriveStatus(inputs: StatusInputs): StatusSummary {
  const summary = deriveOperationalStatus(inputs);
  const { state } = deriveFiveState(inputs);
  const color = inputs.printerPresence === "unknown" && summary.color === "green" ? "amber" : summary.color;
  return { ...summary, color, headline: FIVE_STATE_HEADLINES[state] };
}

/** Counts only since the relay started. No names, no label content. */
export function recentJobs(relay: RelayStatus | null): JobCounts {
  return {
    sent: relay?.counts.sent ?? 0,
    failed: relay?.counts.failed ?? 0,
    ambiguous: relay?.counts.ambiguous ?? 0,
  };
}

export type FiveStateResult = {
  state: FiveState;
  headline: string;
  recoveryAction: string;
};

export const FIVE_STATE_HEADLINES: Record<FiveState, string> = {
  Connected: "Connected",
  Unplugged: "Printer unplugged",
  Waiting: "Waiting for connection",
  "Needs re-enrollment": "Needs re-enrollment",
  "In use elsewhere": "Printer in use elsewhere",
};

export function deriveFiveState(inputs: StatusInputs & { inUseElsewhere?: boolean }): FiveStateResult {
  const { relay } = inputs;
  const cloud = inputs.revoked || relay?.cloud === "revoked" ? "revoked" : relay?.cloud === "ok" ? "ok" : "unreachable";
  const relayState =
    inputs.legacyRelayLoaded || inputs.relayRestarting
      ? "restarting"
      : relay?.state === "running"
        ? "running"
        : relay?.state === "starting"
          ? "starting"
          : "stopped";

  const state = evaluateFiveState({
    printerAttached: inputs.printerAttached,
    printerPresence: inputs.printerPresence,
    enrolled: inputs.enrolled,
    revoked: inputs.revoked,
    inUseElsewhere: Boolean(inputs.inUseElsewhere),
    cloud,
    relayState,
    queue: inputs.queue,
  });

  return {
    state,
    headline: FIVE_STATE_HEADLINES[state],
    recoveryAction: RECOVERY_ACTIONS[state],
  };
}

