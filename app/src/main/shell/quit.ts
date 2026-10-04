/**
 * The quit path. Quitting stops the relay first, and a send that is still
 * writing is never cut off: when `stop` gives up waiting (`abandoned`) the app
 * stays open until the relay reports it has stopped, and only then finishes
 * quitting or installs a downloaded update. While that is going on, further quit
 * requests (the menu, Cmd-Q, logout) are held, so the app cannot exit mid-send.
 */

import type { StopOutcome } from "./supervisor";

export type QuitDeps = {
  /** Stops the relay with its bounded wait. */
  shutdown(): Promise<{ outcome: StopOutcome; jobInFlight: boolean }>;
  /** Resolves when the relay has stopped or exited. */
  settled(): Promise<void>;
  updates: {
    stop(): void;
    /** Installs now (and quits) when an update is ready and no job is in flight. */
    beforeQuit(jobInFlight: boolean): "install" | "defer" | "none";
  };
  /** Quits the Electron app. */
  quit(): void;
  log?: (message: string) => void;
};

export type QuitCoordinator = {
  request(): Promise<void>;
  /** True once the app may really exit: `before-quit` lets it through. */
  isQuitAllowed(): boolean;
};

export function createQuitCoordinator(deps: QuitDeps): QuitCoordinator {
  let inProgress = false;
  let allowed = false;

  return {
    isQuitAllowed: () => allowed,

    async request() {
      if (inProgress) return;
      inProgress = true;
      try {
        deps.updates.stop();
        const result = await deps.shutdown();
        let jobInFlight = result.jobInFlight;
        if (result.outcome === "abandoned") {
          deps.log?.("quit is waiting for the relay to finish its label");
          await deps.settled();
          jobInFlight = false;
        }
        // Set before the update policy runs: installing quits the app itself,
        // and that `before-quit` must not be held back.
        allowed = true;
        if (deps.updates.beforeQuit(jobInFlight) !== "install") deps.quit();
      } catch (error) {
        // A failed shutdown must not leave the app unable to quit later.
        allowed = false;
        inProgress = false;
        throw error;
      }
    },
  };
}
