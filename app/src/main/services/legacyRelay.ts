/**
 * The launchd relay that this app replaces (`church.favor.printrelay`).
 *
 * While it is loaded the app must not start its own relay: two relays would
 * claim the same jobs. Migration boots the agent out and disables it. Neither
 * step reads the old plist or its relay.env, so no credential is copied: the
 * file system adapter can only ask whether the plist exists.
 *
 * Detection fails closed. If `launchctl` cannot be asked, the agent is treated
 * as loaded.
 */

import path from "node:path";

import { LEGACY_LAUNCH_AGENT_LABEL, type MigrateLegacyResult } from "../../shared";
import { BINARIES, type CommandRunner } from "./command";

export type LegacyDetection = {
  /** The plist is in ~/Library/LaunchAgents. */
  plistPresent: boolean;
  /** launchd has the label loaded. True too when launchd could not be asked. */
  loaded: boolean;
};

export type StartGate =
  | { allowed: true }
  | { allowed: false; reason: "legacy_loaded" | "bootout_failed" | "disable_failed" };

export type LegacyRelay = {
  detect(): Promise<LegacyDetection>;
  migrate(): Promise<MigrateLegacyResult>;
  /** The relay starts only when this says allowed. */
  canStartRelay(): Promise<StartGate>;
};

export function legacyPlistPath(homeDir: string): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${LEGACY_LAUNCH_AGENT_LABEL}.plist`);
}

export function createLegacyRelay(deps: {
  run: CommandRunner;
  homeDir: string;
  uid: number;
  /** Existence only. There is deliberately no way to read the file. */
  fileExists(file: string): Promise<boolean>;
}): LegacyRelay {
  const target = `gui/${deps.uid}/${LEGACY_LAUNCH_AGENT_LABEL}`;
  let failure: "bootout_failed" | "disable_failed" | null = null;

  const detect = async (): Promise<LegacyDetection> => {
    const [plistPresent, print] = await Promise.all([
      deps.fileExists(legacyPlistPath(deps.homeDir)),
      deps.run(BINARIES.launchctl, ["print", target]),
    ]);
    // Exit 0: loaded. A plain non-zero exit: launchd does not know the label.
    // No exit code (could not start, timed out): unknown, so assume loaded.
    return { plistPresent, loaded: print.code === null || print.code === 0 };
  };

  return {
    detect,

    async migrate() {
      const bootout = await deps.run(BINARIES.launchctl, ["bootout", target]);
      if (bootout.code !== 0) {
        // Already gone counts as success; anything still loaded does not.
        if ((await detect()).loaded) {
          failure = "bootout_failed";
          return { ok: false, reason: "bootout_failed" };
        }
      }
      const disable = await deps.run(BINARIES.launchctl, ["disable", target]);
      if (disable.code !== 0) {
        failure = "disable_failed";
        return { ok: false, reason: "disable_failed" };
      }
      failure = null;
      return { ok: true };
    },

    async canStartRelay() {
      if (failure) return { allowed: false, reason: failure };
      return (await detect()).loaded ? { allowed: false, reason: "legacy_loaded" } : { allowed: true };
    },
  };
}
