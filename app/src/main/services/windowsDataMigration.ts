/**
 * One-time move of the relay's machine-bound state from the roaming profile
 * (`%APPDATA%\Favor Printer`) to the local one (`%LOCALAPPDATA%\Favor Printer`).
 * The token, `prefs.json` (the paired printer serial) and the spool describe this
 * PC and must not follow an account to another one.
 *
 * Each item is copied, read back, and only then removed from the old folder. An
 * item that already exists at the new path is never overwritten, and a copy that
 * does not read back identically is discarded and the old one is kept. Nothing
 * here throws: a failed move leaves the old data in place and is reported.
 */

import * as nodeFs from "node:fs";
import path from "node:path";

/** What gets moved. Logs and Chromium caches are not state and are left behind. */
export const MIGRATED_ITEMS = ["prefs.json", "relay-token.bin", "spool"] as const;

export type MigrationOutcome = "moved" | "absent" | "kept-existing" | "failed";
export type MigrationResult = { item: string; outcome: MigrationOutcome };

/** The slice of `node:fs` used here. Tests replace it. */
export type MigrationFs = Pick<
  typeof nodeFs,
  "existsSync" | "mkdirSync" | "readdirSync" | "readFileSync" | "rmSync" | "statSync" | "writeFileSync"
>;

type Deps = { from: string; to: string; fs?: MigrationFs; log?: (message: string) => void };

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
  const source = fs.statSync(from);
  if (!source.isDirectory()) {
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

export function migrateWindowsSupportData(deps: Deps): MigrationResult[] {
  const fs = deps.fs ?? nodeFs;
  const log = deps.log ?? (() => undefined);
  const { from, to } = deps;
  if (path.win32.resolve(from).toLowerCase() === path.win32.resolve(to).toLowerCase()) return [];
  return MIGRATED_ITEMS.map((item) => {
    const source = path.join(from, item);
    const target = path.join(to, item);
    let startedCopy = false;
    try {
      if (!fs.existsSync(source)) return { item, outcome: "absent" as const };
      if (fs.existsSync(target)) {
        log(`migrate ${item}: already present at the new path, old copy kept`);
        return { item, outcome: "kept-existing" as const };
      }
      startedCopy = true;
      copyTree(fs, source, target);
      if (!sameTree(fs, source, target)) {
        fs.rmSync(target, { recursive: true, force: true });
        log(`migrate ${item}: copy did not read back identically, old copy kept`);
        return { item, outcome: "failed" as const };
      }
      fs.rmSync(source, { recursive: true, force: true });
      log(`migrate ${item}: moved to the local profile`);
      return { item, outcome: "moved" as const };
    } catch (error) {
      // Only a target this run began writing is cleaned up; the old copy is untouched either way.
      if (startedCopy) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch {
          // Nothing more to do.
        }
      }
      log(`migrate ${item}: failed, old copy kept (${error instanceof Error ? error.name : "error"})`);
      return { item, outcome: "failed" as const };
    }
  });
}
