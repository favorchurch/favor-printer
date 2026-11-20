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
 * The move is all or nothing and staged, so a crash or a failure at any point
 * leaves a complete old copy and never a partial new one:
 *   1. every item that has to move is copied to `<item>.migrating` and read back;
 *   2. only if all of them match, each is renamed into place;
 *   3. only then are the old copies removed. A failed removal is logged and
 *      changes nothing, because the new copy is complete and wins from then on.
 * Any failure in 1 or 2 discards every new copy, keeps every old one, and reports
 * `failed` so the caller keeps running on the old folder for this launch.
 * An item that already exists at the new path is never overwritten.
 */

import * as nodeFs from "node:fs";
import path from "node:path";

/** What gets moved. Logs, caches and `Local State` stay with `userData`. */
export const MIGRATED_ITEMS = ["prefs.json", "relay-token.bin", "spool"] as const;

export type MigrationOutcome = "moved" | "absent" | "kept-existing" | "failed";
export type MigrationResult = { item: string; outcome: MigrationOutcome };

/** The slice of `node:fs` used here. Tests replace it. */
export type MigrationFs = Pick<
  typeof nodeFs,
  "existsSync" | "mkdirSync" | "readdirSync" | "readFileSync" | "renameSync" | "rmSync" | "statSync" | "writeFileSync"
>;

type Deps = { from: string; to: string; fs?: MigrationFs; log?: (message: string) => void };

const STAGING_SUFFIX = ".migrating";

/** True when any item could not be moved: the caller must keep using the old folder this launch. */
export function migrationFailed(results: MigrationResult[]): boolean {
  return results.some((result) => result.outcome === "failed");
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

/** Never includes a message that could carry a path or file content. */
function reason(error: unknown): string {
  if (error instanceof Error) return error.message === "read-back mismatch" ? error.message : error.name;
  return "error";
}

function removeQuietly(fs: MigrationFs, target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Nothing more can be done; callers only use this on copies they own.
  }
}

export function migrateWindowsSupportData(deps: Deps): MigrationResult[] {
  const fs = deps.fs ?? nodeFs;
  const log = deps.log ?? (() => undefined);
  const { from, to } = deps;
  if (path.win32.resolve(from).toLowerCase() === path.win32.resolve(to).toLowerCase()) return [];

  const results = new Map<string, MigrationOutcome>();
  const plan: string[] = [];
  try {
    for (const item of MIGRATED_ITEMS) {
      // A staging copy left by a crashed run is never trusted.
      removeQuietly(fs, path.join(to, item + STAGING_SUFFIX));
      if (!fs.existsSync(path.join(from, item))) results.set(item, "absent");
      else if (fs.existsSync(path.join(to, item))) {
        results.set(item, "kept-existing");
        log(`migrate ${item}: already present at the new path, old copy kept`);
      } else plan.push(item);
    }
  } catch (error) {
    log(`migrate: could not inspect the folders, nothing moved (${reason(error)})`);
    return MIGRATED_ITEMS.map((item) => ({ item, outcome: "failed" as const }));
  }
  const finish = (outcome: MigrationOutcome): MigrationResult[] => {
    for (const item of plan) results.set(item, outcome);
    return MIGRATED_ITEMS.map((item) => ({ item, outcome: results.get(item) ?? "absent" }));
  };
  if (plan.length === 0) return finish("moved");

  const staging = (item: string) => path.join(to, item + STAGING_SUFFIX);
  const discardStaging = () => plan.forEach((item) => removeQuietly(fs, staging(item)));

  // 1. Stage and verify everything before anything is put in place.
  try {
    for (const item of plan) {
      copyTree(fs, path.join(from, item), staging(item));
      if (!sameTree(fs, path.join(from, item), staging(item))) throw new Error("read-back mismatch");
    }
  } catch (error) {
    discardStaging();
    log(`migrate: staging failed, nothing moved, old copies kept (${reason(error)})`);
    return finish("failed");
  }

  // 2. Put each verified copy in place. The old copies are all still there until this is done.
  const placed: string[] = [];
  try {
    for (const item of plan) {
      fs.renameSync(staging(item), path.join(to, item));
      placed.push(item);
    }
  } catch (error) {
    placed.forEach((item) => removeQuietly(fs, path.join(to, item)));
    discardStaging();
    log(`migrate: could not put the copies in place, nothing moved, old copies kept (${reason(error)})`);
    return finish("failed");
  }

  // 3. The new copies are complete. Failing to remove an old one only leaves it behind.
  for (const item of plan) {
    try {
      fs.rmSync(path.join(from, item), { recursive: true, force: true });
      log(`migrate ${item}: moved to the local profile`);
    } catch (error) {
      log(`migrate ${item}: moved, but the old copy could not be removed (${reason(error)})`);
    }
  }
  return finish("moved");
}
