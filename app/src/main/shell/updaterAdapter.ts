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
