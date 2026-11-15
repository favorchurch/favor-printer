/**
 * Pure status reducer for Favor Printer.
 *
 * Maps relay and printer signals to exactly one of the five states:
 *   - Connected
 *   - Unplugged
 *   - Waiting
 *   - Needs re-enrollment
 *   - In use elsewhere
 *
 * Each state has exactly one recovery action.
 */

export type FiveState =
  | "Connected"
  | "Unplugged"
  | "Waiting"
  | "Needs re-enrollment"
  | "In use elsewhere";

export type PrinterPresence = "unknown" | "attached" | "detached";

export type PrinterPresenceState = {
  presence: PrinterPresence;
  lastSeenAt: string | null;
  consecutiveFailures: number;
};

export type PrinterPresenceSignal =
  | { type: "printer_found"; seenAt: string }
  | { type: "printer_absent" }
  | { type: "listing_failed" };

export const INITIAL_PRINTER_PRESENCE: PrinterPresenceState = {
  presence: "unknown",
  lastSeenAt: null,
  consecutiveFailures: 0,
};

export const PRINTER_PRESENCE_FAILURE_LIMIT = 2;

/** A second consecutive failed listing expires stale presence without inventing a detach. */
export function printerPresenceReducer(
  current: PrinterPresenceState,
  signal: PrinterPresenceSignal,
): PrinterPresenceState {
  if (signal.type === "printer_found") {
    return {
      presence: "attached",
      lastSeenAt: signal.seenAt,
      consecutiveFailures: 0,
    };
  }
  if (signal.type === "printer_absent") {
    return { ...current, presence: "detached", consecutiveFailures: 0 };
  }

  const consecutiveFailures = current.consecutiveFailures + 1;
  return {
    ...current,
    presence:
      consecutiveFailures >= PRINTER_PRESENCE_FAILURE_LIMIT ? "unknown" : current.presence,
    consecutiveFailures,
  };
}

export const FIVE_STATES = [
  "Connected",
  "Unplugged",
  "Waiting",
  "Needs re-enrollment",
  "In use elsewhere",
] as const;

export const RECOVERY_ACTIONS: Record<FiveState, string> = {
  Connected: "Run a local test print in Favor Printer to verify labels.",
  Unplugged: "Plug in the Zebra with its USB cable.",
  Waiting: "Check the internet connection and wait for Favor RSVP to respond.",
  "Needs re-enrollment": "Ask an admin for a new six-digit code in Favor RSVP.",
  "In use elsewhere": "Ask an admin to disconnect this printer from the other laptop.",
};

/** Shown when RSVP answers but lists no enabled printer for this laptop (turned off, removed or handed over). */
export const NO_ENABLED_PRINTERS_DETAIL = "RSVP has no enabled printer for this laptop, so nothing can print.";
export const NO_ENABLED_PRINTERS_RECOVERY =
  "Ask an admin to turn the printer on in RSVP printing settings, or pair with a new code.";

/** Pill label for the same state. RSVP did answer, so it is not "Waiting for connection". */
export const NO_ENABLED_PRINTERS_HEADLINE = "Needs attention";

/**
 * True when RSVP lists no enabled printer for this laptop, whatever the local printer is doing.
 * An empty list alone only means the relay is still starting, so it needs proof that RSVP answered:
 * a heartbeat, or the relay's own report of a config it cannot use (a printer that was turned off,
 * removed or handed over never gets a heartbeat, so lastHeartbeatAt stays null for it).
 */
export function hasNoEnabledPrinters(
  state: FiveState,
  relay: {
    state: string;
    cloud: string;
    printerIds: readonly string[];
    lastHeartbeatAt: string | null;
    lastError?: string | null;
    handedOverPrinterIds?: readonly string[];
  } | null,
): boolean {
  // RSVP's answer does not depend on the local printer, so an unplugged or unknown printer does not hide it.
  // The two states that mean this laptop's own pairing is wrong keep their own recovery.
  if (state === "Needs re-enrollment" || state === "In use elsewhere" || relay === null || relay.state !== "running" || relay.cloud !== "ok") return false;
  if (relay.printerIds.length > 0) return false;
  return (
    relay.lastHeartbeatAt !== null ||
    relay.lastError === "config_invalid" ||
    relay.lastError === "printer_handed_over" ||
    (relay.handedOverPrinterIds?.length ?? 0) > 0
  );
}

export type PrinterSignal =
  | { type: "printer_attached" }
  | { type: "printer_unplugged" }
  | { type: "queue_ready" }
  | { type: "queue_missing" }
  | { type: "queue_disabled" };

export type RelaySignal =
  | { type: "relay_running" }
  | { type: "relay_starting" }
  | { type: "relay_restarting" }
  | { type: "relay_stopped" }
  | { type: "cloud_ok" }
  | { type: "cloud_unreachable" }
  | { type: "cloud_revoked" }
  | { type: "printer_conflict"; conflict: "serial_in_use" | string }
  | { type: "conflict_cleared" }
  | { type: "enrolled" }
  | { type: "not_enrolled" };

export type StatusSignal = PrinterSignal | RelaySignal;

export type StatusState = {
  state: FiveState;
  recoveryAction: string;
  printerAttached: boolean;
  enrolled: boolean;
  revoked: boolean;
  inUseElsewhere: boolean;
  cloud: "ok" | "unreachable" | "revoked";
  relayState: "starting" | "running" | "restarting" | "stopped";
  queue: "ready" | "missing" | "disabled";
};

export const INITIAL_STATUS_STATE: StatusState = {
  state: "Waiting",
  recoveryAction: RECOVERY_ACTIONS.Waiting,
  printerAttached: false,
  enrolled: false,
  revoked: false,
  inUseElsewhere: false,
  cloud: "unreachable",
  relayState: "stopped",
  queue: "missing",
};

export function evaluateFiveState(context: {
  printerAttached: boolean;
  printerPresence?: PrinterPresence;
  enrolled: boolean;
  revoked: boolean;
  inUseElsewhere: boolean;
  cloud: "ok" | "unreachable" | "revoked";
  relayState: "starting" | "running" | "restarting" | "stopped";
  queue: "ready" | "missing" | "disabled";
}): FiveState {
  if (context.revoked || !context.enrolled || context.cloud === "revoked") {
    return "Needs re-enrollment";
  }
  if (context.printerPresence === "unknown") {
    return "Waiting";
  }
  if (!context.printerAttached) {
    return "Unplugged";
  }
  if (context.inUseElsewhere) {
    return "In use elsewhere";
  }
  if (
    context.cloud === "unreachable" ||
    context.relayState !== "running" ||
    context.queue !== "ready"
  ) {
    return "Waiting";
  }
  return "Connected";
}

/**
 * Pure status reducer: takes current state and a signal from the relay or printer,
 * and produces the next state with its mapped recovery action.
 */
export function statusReducer(current: StatusState, signal: StatusSignal): StatusState {
  const next: StatusState = { ...current };

  switch (signal.type) {
    case "printer_attached":
      next.printerAttached = true;
      break;
    case "printer_unplugged":
      next.printerAttached = false;
      break;
    case "queue_ready":
      next.queue = "ready";
      break;
    case "queue_missing":
      next.queue = "missing";
      break;
    case "queue_disabled":
      next.queue = "disabled";
      break;

    case "relay_running":
      next.relayState = "running";
      break;
    case "relay_starting":
      next.relayState = "starting";
      break;
    case "relay_restarting":
      next.relayState = "restarting";
      break;
    case "relay_stopped":
      next.relayState = "stopped";
      break;

    case "cloud_ok":
      next.cloud = "ok";
      next.revoked = false;
      break;
    case "cloud_unreachable":
      next.cloud = "unreachable";
      break;
    case "cloud_revoked":
      next.cloud = "revoked";
      next.revoked = true;
      break;

    case "printer_conflict":
      if (signal.conflict === "serial_in_use") {
        next.inUseElsewhere = true;
      }
      break;
    case "conflict_cleared":
      next.inUseElsewhere = false;
      break;

    case "enrolled":
      next.enrolled = true;
      next.revoked = false;
      break;
    case "not_enrolled":
      next.enrolled = false;
      break;
  }

  const evaluated = evaluateFiveState(next);
  next.state = evaluated;
  next.recoveryAction = RECOVERY_ACTIONS[evaluated];
  return next;
}
