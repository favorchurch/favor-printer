/**
 * Update policy, separate from electron-updater so it can be tested by hand:
 * check at launch and every 6 hours, download in the background, and install
 * only at quit with no job in flight. A failed check or download never stops
 * printing and never hides an update that is already downloaded.
 */

import type { ReconciliationState } from "../../../../vendor/relay/status";
import type { UpdateChannel, UpdateState } from "../../shared";
import { systemTimers, type Timers } from "./timers";

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "not-available" }
  | { kind: "downloaded"; version: string }
  | { kind: "error" };

/** The slice of electron-updater the controller drives. The real adapter maps its events to `UpdaterEvent`. */
export type UpdaterAdapter = {
  configure(settings: { allowPrerelease: boolean; allowDowngrade: boolean }): void;
  subscribe(listener: (event: UpdaterEvent) => void): void;
  check(): Promise<void>;
  quitAndInstall(): void;
};

/** `preview` follows GitHub prereleases. Switching channels never downgrades. */
export function channelSettings(channel: UpdateChannel): { allowPrerelease: boolean; allowDowngrade: boolean } {
  return { allowPrerelease: channel === "preview", allowDowngrade: false };
}

export type InstallDecision = "install" | "defer" | "none";

/**
 * A job in flight or a claimed job with no recorded outcome blocks the install. `pendingEntries` is what the
 * relay's last status shows: claimed jobs that are not yet sent, failed or ambiguous.
 */
export function installDecision(input: { updateReady: boolean; jobInFlight: boolean; pendingEntries: number; reconciliation: ReconciliationState }): InstallDecision {
  if (!input.updateReady) return "none";
  return input.jobInFlight || input.pendingEntries > 0 || input.reconciliation !== "complete" ? "defer" : "install";
}

export type UpdateController = {
  start(): void;
  stop(): void;
  setChannel(channel: UpdateChannel): Promise<void>;
  checkNow(): Promise<void>;
  state(): UpdateState;
  /** ISO time of the last check that got an answer from the feed, or null. */
  lastCheckedAt(): string | null;
  /** Call when the volunteer quits. Installs now, or waits for `jobsSettled`. */
  beforeQuit(jobInFlight: boolean, pendingEntries: number, reconciliation: ReconciliationState): InstallDecision;
  /** Call when the in-flight job has finished. Installs an update deferred by `beforeQuit`. */
  jobsSettled(jobInFlight: boolean, pendingEntries: number, reconciliation: ReconciliationState): void;
};

export function createUpdateController(deps: {
  adapter: UpdaterAdapter;
  channel: UpdateChannel;
  onState?: (state: UpdateState) => void;
  /** Called with the time (ISO) of each check that got an answer from the feed. */
  onChecked?: (checkedAt: string) => void;
  timers?: Timers;
  now?: () => Date;
}): UpdateController {
  const { adapter } = deps;
  const timers = deps.timers ?? systemTimers;

  let state: UpdateState = { kind: "idle" };
  let interval: unknown = null;
  let installPending = false;
  let installed = false;
  let checkedAt: string | null = null;

  const set = (next: UpdateState) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    deps.onState?.(next);
  };

  const now = deps.now ?? (() => new Date());

  const answered = () => {
    checkedAt = now().toISOString();
    deps.onChecked?.(checkedAt);
  };

  /** Never twice: the app is already on its way out after the first. */
  const install = () => {
    if (installed) return;
    installed = true;
    adapter.quitAndInstall();
  };

  const handle = (event: UpdaterEvent) => {
    if (event.kind === "available" || event.kind === "not-available" || event.kind === "downloaded") answered();    // A downloaded update stays offered whatever a later check reports.
    if (state.kind === "ready" && event.kind !== "downloaded") return;
    switch (event.kind) {
      case "checking":
        return set({ kind: "checking" });
      case "available":
        return set({ kind: "downloading", version: event.version });
      case "not-available":
        return set({ kind: "idle" });
      case "downloaded":
        return set({ kind: "ready", version: event.version });
      case "error":
        return set({ kind: "error" });
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  };

  const checkNow = async () => {
    try {
      await adapter.check();
    } catch {
      handle({ kind: "error" });
    }
  };

  adapter.configure(channelSettings(deps.channel));
  adapter.subscribe(handle);

  return {
    start() {
      void checkNow();
      if (interval === null) interval = timers.setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
    },
    stop() {
      if (interval !== null) timers.clearInterval(interval);
      interval = null;
    },
    async setChannel(channel) {
      adapter.configure(channelSettings(channel));
      await checkNow();
    },
    checkNow,
    state: () => state,
    lastCheckedAt: () => checkedAt,
    beforeQuit(jobInFlight, pendingEntries, reconciliation) {
      const decision = installDecision({ updateReady: state.kind === "ready", jobInFlight, pendingEntries, reconciliation });
      if (decision === "install") install();
      if (decision === "defer") installPending = true;
      return decision;
    },
    jobsSettled(jobInFlight, pendingEntries, reconciliation) {
      if (!installPending || installDecision({ updateReady: state.kind === "ready", jobInFlight, pendingEntries, reconciliation }) !== "install") return;
      installPending = false;
      install();
    },
  };
}