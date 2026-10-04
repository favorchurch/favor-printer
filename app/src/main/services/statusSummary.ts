/**
 * Turns relay, cloud, printer, update and pause state into the tray colour and
 * copy. The first matching rule wins, so the order below is the priority:
 * a removed laptop outranks everything, and green needs every light on.
 */

import type { JobCounts, QueueState, StatusSummary, UpdateState } from "../../shared";
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
  queue: QueueState;
  paused: boolean;
  update: UpdateState;
};

const amber = (headline: string, detail: string | null): StatusSummary => ({ color: "amber", headline, detail });

export function deriveStatus(inputs: StatusInputs): StatusSummary {
  const { relay } = inputs;

  if (inputs.revoked || relay?.cloud === "revoked") {
    return { color: "red", headline: REVOKED_HEADLINE, detail: null };
  }
  if (inputs.legacyRelayLoaded) {
    return amber("The old print relay is still running", "Move to Favor Printer to start printing.");
  }
  if (!inputs.enrolled) return amber("Not set up yet", "Enter the six-digit code from an admin.");
  if (inputs.relayRestarting) return amber("Print relay is restarting", "Printing resumes in a moment.");
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

/** Counts only since the relay started. No names, no label content. */
export function recentJobs(relay: RelayStatus | null): JobCounts {
  return {
    sent: relay?.counts.sent ?? 0,
    failed: relay?.counts.failed ?? 0,
    ambiguous: relay?.counts.ambiguous ?? 0,
  };
}
