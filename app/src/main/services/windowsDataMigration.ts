/**
 * One-time move of the relay's machine-bound state from the roaming profile
 * (`%APPDATA%\Favor Printer`) to the local one (`%LOCALAPPDATA%\Favor Printer`).
 * The token, `prefs.json` (the paired printer serial) and the spool describe this
 * PC and must not follow an account to another one.
 *
 * Electron's `userData` does NOT move. The token is encrypted with a key that
 * Chromium keeps in `<userData>\Local State`; a token that has moved away from
 * that key can no longer be decrypted and the PC would silently lose its pairing.
 *
 * `<to>\.migrated` is the commit point. Until it exists nothing in the new folder
 * is trusted, and the old copies are never touched:
 *   1. every item that has to move is copied to `<item>.migrating` and read back;
 *   2. each verified copy is renamed into place;
 *   3. the marker is written. This is the moment the new folder becomes the truth;
 *   4. the old copies are removed on the NEXT start, not in this one. Windows does not
 *      flush file contents before a power cut, so deleting the old copy in the same
 *      launch could leave neither copy intact. A failed removal is retried on every
 *      later start and is never allowed to bring the old data back.
 * A failure or a crash before 3 leaves complete old copies. The next start treats
 * whatever is in the new folder as uncommitted debris, removes it and starts over,
 * so a half-placed set can never win, and the caller runs on the old folder for the
 * launch that failed. Once the marker exists nothing is ever imported again, so an
 * old token that survived a failed delete cannot come back after the PC is revoked.
 *
 * Known limit: the marker lives in %LOCALAPPDATA%, which does not roam, while leftovers in
 * %APPDATA% do. If a leftover could not be deleted AND the local folder is later wiped, or a
 * roaming profile carries a leftover to another PC, that PC has no marker and imports it.
 * Before this change the older build read that roamed folder directly, so nothing new is exposed.
 */

import * as nodeFs from "node:fs";
import path from "node:path";

/** What gets moved. Logs, caches and `Local State` stay with `userData`. */
export const MIGRATED_ITEMS = ["prefs.json", "relay-token.bin", "spool"] as const;

/** Written last. Its presence means the new folder is the truth and the old one is only leftovers. */
export const MIGRATION_MARKER = ".migrated";

export type MigrationOutcome = "moved" | "absent" | "failed";
export type MigrationResult = { item: string; outcome: MigrationOutcome };

/** The slice of `node:fs` used here. Tests replace it. */
export type MigrationFs = Pick<
  typeof nodeFs,
  "mkdirSync" | "readdirSync" | "readFileSync" | "renameSync" | "rmSync" | "statSync" | "writeFileSync"
>;

type Deps = {
  from: string;
  to: string;
  fs?: MigrationFs;
  log?: (message: string) => void;
  /** Blocks for `ms`. Antivirus and indexers hold freshly written files for a moment. Tests pass a no-op. */
  sleep?: (ms: number) => void;
};

const STAGING_SUFFIX = ".migrating";
const RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
const ATTEMPTS = 5;
const RETRY_DELAY_MS = 100;

/** True when the new folder could not be made the truth: the caller must keep using the old folder this launch. */
export function migrationFailed(results: MigrationResult[]): boolean {
  return results.some((result) => result.outcome === "failed");
}

/** The error's code (EPERM, EBUSY, ENOSPC...) for the log. Never a message, which can carry a path or file content. */
function reason(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "read-back mismatch") return error.message;
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" && /^[A-Z0-9_]{3,20}$/.test(code) ? code : error.name;
  }
  return "error";
}

const defaultSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Only "not there" counts as absent. Any other error (an unreachable share, a denied stat) must not look like a fresh install. */
function exists(fs: MigrationFs, target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** Relative file paths under `root`, sorted. A plain file is `[""]`. */
function listFiles(fs: MigrationFs, root: string, rel = ""): string[] {
  const full = rel ? path.join(root, rel) : root;
  if (!fs.statSync(full).isDirectory()) return [rel];
  return fs
    .readdirSync(full)
    .sort()
    .flatMap((name) => listFiles(fs, root, rel ? path.join(rel, name) : name));
}

function copyTree(fs: MigrationFs, from: string, to: string): void {
  if (!fs.statSync(from).isDirectory()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(from));
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) copyTree(fs, path.join(from, name), path.join(to, name));
}

function sameTree(fs: MigrationFs, a: string, b: string): boolean {
  const left = listFiles(fs, a);
  const right = listFiles(fs, b);
  if (left.length !== right.length || left.some((rel, i) => rel !== right[i])) return false;
  return left.every((rel) => {
    const x = rel ? path.join(a, rel) : a;
    const y = rel ? path.join(b, rel) : b;
    return fs.readFileSync(x).equals(fs.readFileSync(y));
  });
}

/** Retries the transient errors Windows raises for a file something else is briefly holding. */
function withRetries<T>(sleep: (ms: number) => void, action: () => T, attempts = ATTEMPTS): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= attempts || typeof code !== "string" || !RETRY_CODES.has(code)) throw error;
      sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

function removeQuietly(fs: MigrationFs, sleep: (ms: number) => void, target: string, attempts = ATTEMPTS): boolean {
  try {
    withRetries(sleep, () => fs.rmSync(target, { recursive: true, force: true }), attempts);
    return true;
  } catch {
    return false;
  }
}

export function migrateWindowsSupportData(deps: Deps): MigrationResult[] {
  const fs = deps.fs ?? nodeFs;
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? defaultSleep;
  const { from, to } = deps;
  if (path.win32.resolve(from).toLowerCase() === path.win32.resolve(to).toLowerCase()) return [];
  const failedAll = MIGRATED_ITEMS.map((item) => ({ item, outcome: "failed" as const }));
  try {
    return migrate(fs, log, sleep, from, to);
  } catch (error) {
    // An error that is not "the file is not there" (an unreachable share, a denied stat) must never look like a fresh
    // install, which would commit an empty new folder and later delete the real old data.
    log(`migrate: could not inspect the folders, nothing moved, using the old one (${reason(error)})`);
    return failedAll;
  }
}

function migrate(fs: MigrationFs, log: (message: string) => void, sleep: (ms: number) => void, from: string, to: string): MigrationResult[] {
  const marker = path.join(to, MIGRATION_MARKER);
  const staging = (item: string) => path.join(to, item + STAGING_SUFFIX);
  const absent = MIGRATED_ITEMS.map((item) => ({ item, outcome: "absent" as const }));
  const failedAll = MIGRATED_ITEMS.map((item) => ({ item, outcome: "failed" as const }));

  // The new folder is already the truth. Old leftovers are only cleaned up, never imported.
  if (exists(fs, marker)) {
    for (const item of MIGRATED_ITEMS) {
      if (!exists(fs, path.join(from, item))) continue;
      // Two attempts: a leftover that can never be deleted must not slow every start.
      const removed = removeQuietly(fs, sleep, path.join(from, item), 2);
      log(removed ? `migrate ${item}: removed the old copy left in the roaming profile` : `migrate ${item}: old copy still could not be removed`);
    }
    return absent;
  }

  // Before the marker nothing in the new folder is trusted, whether or not an old copy of that item still exists:
  // a failed or crashed earlier attempt may have left an item or a staging copy there, and the old folder may have
  // changed since (a revocation deletes the old token). The new folder only ever holds real data after the marker.
  const plan: string[] = [];
  for (const item of MIGRATED_ITEMS) {
    const clear = (target: string) => !exists(fs, target) || removeQuietly(fs, sleep, target);
    if (!clear(staging(item)) || !clear(path.join(to, item))) {
      log(`migrate ${item}: could not clear an earlier attempt, nothing moved, using the old folder`);
      return failedAll;
    }
    if (exists(fs, path.join(from, item))) plan.push(item);
  }
  const results = (outcome: MigrationOutcome): MigrationResult[] =>
    MIGRATED_ITEMS.map((item) => ({ item, outcome: plan.includes(item) ? outcome : "absent" }));
  const discard = (placed: string[]) => {
    for (const item of placed) removeQuietly(fs, sleep, path.join(to, item));
    for (const item of plan) removeQuietly(fs, sleep, staging(item));
  };
  const commit = (): void => {
    fs.mkdirSync(to, { recursive: true });
    withRetries(sleep, () => fs.writeFileSync(marker, "1\n"));
  };

  // Nothing to move (a fresh install, or nothing was ever paired): the new folder is the truth from now on.
  if (plan.length === 0) {
    try {
      commit();
      return absent;
    } catch (error) {
      log(`migrate: could not create the local folder, using the old one (${reason(error)})`);
      return failedAll;
    }
  }

  // 1. Stage and verify everything before anything is put in place.
  try {
    for (const item of plan) {
      copyTree(fs, path.join(from, item), staging(item));
      if (!sameTree(fs, path.join(from, item), staging(item))) throw new Error("read-back mismatch");
    }
  } catch (error) {
    discard([]);
    log(`migrate: staging failed, nothing moved, old copies kept (${reason(error)})`);
    return results("failed");
  }

  // 2. Put each verified copy in place, then 3. commit. The old copies are all still there until the marker exists.
  const placed: string[] = [];
  try {
    for (const item of plan) {
      withRetries(sleep, () => fs.renameSync(staging(item), path.join(to, item)));
      placed.push(item);
    }
    commit();
  } catch (error) {
    discard(placed);
    log(`migrate: could not put the copies in place, nothing moved, old copies kept (${reason(error)})`);
    return results("failed");
  }

  // 4. Committed. The old copies are deleted on the next start, once the new files have long been flushed to disk.
  for (const item of plan) log(`migrate ${item}: moved to the local profile`);
  return results("moved");
}

/**
 * The folder the relay's token, preferences and spool live in for this launch: the local folder once the migration
 * has made it the truth, otherwise the old folder. Every consumer must use the one value this returns.
 */
export function chooseSupportDir(deps: Deps & { userDataDir: string }): string {
  return migrationFailed(migrateWindowsSupportData(deps)) ? deps.userDataDir : deps.to;
}
