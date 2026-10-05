/**
 * Connects `electron-updater` to the update policy in services/updates.ts.
 * The updater downloads in the background but never installs on its own:
 * `autoInstallOnAppQuit` stays off, and the policy calls `quitAndInstall` only
 * when no job is in flight. Errors are logged as one redacted line.
 */

import type { UpdaterAdapter, UpdaterEvent } from "../services";
import { describeError, type Logger } from "./log";

/** The slice of electron-updater's `AppUpdater` used here. */
export type AutoUpdaterLike = {
  /** electron-updater's `channel` setter also turns `allowDowngrade` on, and cannot be set back to null. */
  channel?: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: { info(message?: unknown): void; warn(message?: unknown): void; error(message?: unknown): void } | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

/** A release version: `1.2.3`, optionally with a prerelease or build suffix. Anything else is not shown. */
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,40})?$/;

export function safeVersion(value: unknown): string {
  return typeof value === "string" && VERSION.test(value) ? value : "";
}

/**
 * Preview follows `beta`. In electron-updater 6.8.9 the GitHub provider offers only stable releases
 * and `beta` ones to a client on the `alpha` or `beta` channel, and skips every other prerelease tag.
 * Preview releases are tagged `vX.Y.Z-beta.N` for that reason.
 */
export const PREVIEW_CHANNEL = "beta";

/** The default channel file name (`latest.yml`). Once any channel is set it cannot be cleared, so Stable names this one. */
export const STABLE_CHANNEL = "latest";

export function createUpdaterAdapter(updater: AutoUpdaterLike, log: Logger): UpdaterAdapter {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.logger = {
    info: () => undefined,
    // The updater's own messages are free text; only an Error's class and code are kept.
    warn: (message) => log("warn", "updater", describeError(message)),
    error: (message) => log("error", "updater", describeError(message)),
  };

  return {
    configure(settings) {
      updater.allowPrerelease = settings.allowPrerelease;
      if (settings.allowPrerelease) {
        updater.channel = PREVIEW_CHANNEL;
      } else if (updater.channel != null) {
        // Coming back from Preview. A fresh Stable client never sets a channel at all.
        updater.channel = STABLE_CHANNEL;
      }
      // Last: setting a channel turns downgrades on, and an update must never be a lower version.
      updater.allowDowngrade = settings.allowDowngrade;
    },
    subscribe(listener: (event: UpdaterEvent) => void) {
      updater.on("checking-for-update", () => listener({ kind: "checking" }));
      updater.on("update-available", () => listener({ kind: "available" }));
      updater.on("update-not-available", () => listener({ kind: "not-available" }));
      updater.on("update-downloaded", ((info: { version?: unknown }) =>
        listener({ kind: "downloaded", version: safeVersion(info?.version) })) as never);
      updater.on("error", ((error: unknown) => {
        log("error", "updater", `update failed: ${describeError(error)}`);
        listener({ kind: "error" });
      }) as never);
    },
    async check() {
      await updater.checkForUpdates();
    },
    quitAndInstall() {
      updater.quitAndInstall(false, true);
    },
  };
}
