/**
 * Update policy, separate from electron-updater so it can be tested by hand:
 * check at launch and every 6 hours, download in the background, and install
 * only at quit with no job in flight. A failed check or download never stops
 * printing and never hides an update that is already downloaded.
 */

import type { UpdateChannel, UpdateState } from "../../shared";
import { systemTimers, type Timers } from "./timers";

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdaterEvent =
  | { kind: "checking" }
  | { kind: "available" }
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

export function installDecision(input: { updateReady: boolean; jobInFlight: boolean }): InstallDecision {
  if (!input.updateReady) return "none";
  return input.jobInFlight ? "defer" : "install";
}

export type UpdateController = {
  start(): void;
  stop(): void;
  setChannel(channel: UpdateChannel): Promise<void>;
  checkNow(): Promise<void>;
  state(): UpdateState;
  /** Call when the volunteer quits. Installs now, or waits for `jobsSettled`. */
  beforeQuit(jobInFlight: boolean): InstallDecision;
  /** Call when the in-flight job has finished. Installs an update deferred by `beforeQuit`. */
  jobsSettled(): void;
};

export function createUpdateController(deps: {
  adapter: UpdaterAdapter;
  channel: UpdateChannel;
  onState?: (state: UpdateState) => void;
  timers?: Timers;
}): UpdateController {
  const { adapter } = deps;
  const timers = deps.timers ?? systemTimers;

  let state: UpdateState = { kind: "idle" };
  let interval: unknown = null;
  let installPending = false;

  const set = (next: UpdateState) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    deps.onState?.(next);
  };

  const handle = (event: UpdaterEvent) => {
    // A downloaded update stays offered whatever a later check reports.
    if (state.kind === "ready" && event.kind !== "downloaded") return;
    switch (event.kind) {
      case "checking":
        return set({ kind: "checking" });
      case "available":
        return set({ kind: "downloading" });
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
    beforeQuit(jobInFlight) {
      const decision = installDecision({ updateReady: state.kind === "ready", jobInFlight });
      if (decision === "install") adapter.quitAndInstall();
      if (decision === "defer") installPending = true;
      return decision;
    },
    jobsSettled() {
      if (!installPending) return;
      installPending = false;
      adapter.quitAndInstall();
    },
  };
}
