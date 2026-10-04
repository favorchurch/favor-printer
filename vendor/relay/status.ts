/**
 * What the embedded relay tells its host app. Counts, states and ids only:
 * never a label, ZPL, name or security code, so a status can be shown in a
 * menu, logged or forwarded as is.
 */

export type RelayState = "starting" | "running" | "paused" | "stopping" | "stopped";

/** `unreachable` until the cloud has answered once. */
export type CloudState = "ok" | "unreachable" | "revoked";

/** A fixed set of codes, so no error text carrying a payload can leak through. */
export type RelayErrorCode =
  | "cloud_unreachable"
  | "credentials_rejected"
  | "config_unavailable"
  | "config_invalid"
  | "spool_locked"
  | "invalid_options"
  | "send_failed"
  | "send_ambiguous"
  | "unexpected";

export type RelayCounts = {
  claimed: number;
  sent: number;
  failed: number;
  ambiguous: number;
};

export type RelayStatus = {
  state: RelayState;
  cloud: CloudState;
  printerIds: string[];
  inFlight: boolean;
  /** Since this relay started. */
  counts: RelayCounts;
  lastJobAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: RelayErrorCode | null;
};

/** An event is the full status after a change. */
export type RelayEvent = RelayStatus;

const CLOUD_ERRORS: RelayErrorCode[] = [
  "cloud_unreachable",
  "credentials_rejected",
  "config_unavailable",
];
const SEND_ERRORS: RelayErrorCode[] = ["send_failed", "send_ambiguous"];

export function createStatusTracker(
  onEvent: ((event: RelayEvent) => void) | undefined,
  now: () => Date,
) {
  let status: RelayStatus = {
    state: "stopped",
    cloud: "unreachable",
    printerIds: [],
    inFlight: false,
    counts: { claimed: 0, sent: 0, failed: 0, ambiguous: 0 },
    lastJobAt: null,
    lastHeartbeatAt: null,
    lastError: null,
  };
  let emitted = JSON.stringify(status);

  const copy = (): RelayStatus => ({
    ...status,
    printerIds: [...status.printerIds],
    counts: { ...status.counts },
  });

  /** Apply a change and emit only if something visible moved. */
  const update = (change: (draft: RelayStatus) => void) => {
    const draft = copy();
    change(draft);
    status = draft;
    const json = JSON.stringify(status);
    if (json === emitted) return;
    emitted = json;
    onEvent?.(copy());
  };

  return {
    snapshot: copy,
    reset() {
      update((s) => {
        s.counts = { claimed: 0, sent: 0, failed: 0, ambiguous: 0 };
        s.lastJobAt = null;
        s.lastHeartbeatAt = null;
        s.lastError = null;
        s.inFlight = false;
      });
    },
    state(state: RelayState) {
      update((s) => {
        s.state = state;
      });
    },
    printerIds(ids: string[]) {
      update((s) => {
        s.printerIds = [...ids];
      });
    },
    inFlight(value: boolean) {
      update((s) => {
        s.inFlight = value;
      });
    },
    claimed() {
      update((s) => {
        s.counts.claimed += 1;
      });
    },
    outcome(outcome: "sent" | "failed" | "ambiguous") {
      update((s) => {
        s.counts[outcome] += 1;
        s.lastJobAt = now().toISOString();
        if (outcome === "sent") {
          if (s.lastError && SEND_ERRORS.includes(s.lastError)) s.lastError = null;
        } else {
          s.lastError = outcome === "failed" ? "send_failed" : "send_ambiguous";
        }
      });
    },
    heartbeat() {
      update((s) => {
        s.lastHeartbeatAt = now().toISOString();
      });
    },
    cloudOk() {
      update((s) => {
        s.cloud = "ok";
        if (s.lastError && CLOUD_ERRORS.includes(s.lastError)) s.lastError = null;
      });
    },
    cloudUnreachable() {
      update((s) => {
        s.cloud = "unreachable";
        s.lastError = "cloud_unreachable";
      });
    },
    cloudRevoked() {
      update((s) => {
        s.cloud = "revoked";
        s.lastError = "credentials_rejected";
      });
    },
    error(code: RelayErrorCode) {
      update((s) => {
        s.lastError = code;
      });
    },
  };
}
