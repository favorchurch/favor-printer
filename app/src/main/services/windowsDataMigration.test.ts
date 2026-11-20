import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chooseSupportDir,
  MIGRATED_ITEMS,
  MIGRATION_MARKER,
  migrateWindowsSupportData,
  migrationFailed,
  type MigrationFs,
} from "./windowsDataMigration";

let root: string;
let from: string;
let to: string;
const token = Buffer.from([0x01, 0x00, 0x00, 0x00, 0xd0, 0x8c, 0x9d, 0xdf, 0x00, 0xff, 0x10]);
const noSleep = () => undefined;
const SPOOL_FILES = ["job-1.json", "job-1.send", path.join("nested", "job-2.json")];

function write(file: string, data: string | Buffer): void {
  nodeFs.mkdirSync(path.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, data);
}

function seedOld(): void {
  write(path.join(from, "prefs.json"), '{"pairedUsbSerial":"D9J200100001"}');
  write(path.join(from, "relay-token.bin"), token);
  write(path.join(from, "spool", "job-1.json"), '{"state":"ambiguous"}');
  write(path.join(from, "spool", "job-1.send"), "marker");
  write(path.join(from, "spool", "nested", "job-2.json"), "{}");
}

const realFs: MigrationFs = {
  closeSync: nodeFs.closeSync,
  fsyncSync: nodeFs.fsyncSync,
  openSync: nodeFs.openSync,
  realpathSync: nodeFs.realpathSync,
  mkdirSync: nodeFs.mkdirSync,
  readdirSync: nodeFs.readdirSync,
  readFileSync: nodeFs.readFileSync,
  renameSync: nodeFs.renameSync,
  rmSync: nodeFs.rmSync,
  statSync: nodeFs.statSync,
  writeFileSync: nodeFs.writeFileSync,
};
const fsWith = (over: Partial<MigrationFs>): MigrationFs => ({ ...realFs, ...over });
const fsError = (code: string, message = `${code}: C:\\Users\\secret\\path`) => Object.assign(new Error(message), { code });

/** Every file under `dir`, relative, sorted. */
function tree(dir: string): string[] {
  if (!nodeFs.existsSync(dir)) return [];
  return nodeFs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

const outcomes = (results: { item: string; outcome: string }[]) => Object.fromEntries(results.map((r) => [r.item, r.outcome]));
const run = (extra: { fs?: MigrationFs; log?: (m: string) => void } = {}) => migrateWindowsSupportData({ from, to, sleep: noSleep, ...extra });
const hasMarker = () => nodeFs.existsSync(path.join(to, MIGRATION_MARKER));
const newItems = () => nodeFs.readdirSync(to).sort();

beforeEach(() => {
  root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "favor-printer-migrate-"));
  from = path.join(root, "Roaming", "Favor Printer");
  to = path.join(root, "Local", "Favor Printer");
});

afterEach(() => nodeFs.rmSync(root, { recursive: true, force: true }));

describe("migrateWindowsSupportData", () => {
  it("moves the preferences, the token and the whole spool, byte for byte, and commits", () => {
    seedOld();
    const logs: string[] = [];
    const results = run({ log: (m) => logs.push(m) });
    expect(results).toEqual(MIGRATED_ITEMS.map((item) => ({ item, outcome: "moved" })));
    expect(migrationFailed(results)).toBe(false);
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"D9J200100001"}');
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
    expect(tree(path.join(to, "spool"))).toEqual(SPOOL_FILES);
    expect(nodeFs.readFileSync(path.join(to, "spool", "job-1.send"), "utf8")).toBe("marker");
    expect(hasMarker()).toBe(true);
    expect(newItems()).toEqual([...MIGRATED_ITEMS, MIGRATION_MARKER].sort());
    expect(logs.join("\n")).not.toContain("D9J200100001");
  });

  it("leaves the old copies in place in the committing launch and removes them on the next start", () => {
    seedOld();
    run();
    // Windows does not flush file contents before a power cut, so the old copy outlives the launch that moved it.
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
    run();
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(false);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
    expect(tree(path.join(to, "spool"))).toEqual(SPOOL_FILES);
  });

  it("commits a fresh install with nothing to move, so a later stray old folder is never imported", () => {
    expect(run()).toEqual(MIGRATED_ITEMS.map((item) => ({ item, outcome: "absent" })));
    expect(hasMarker()).toBe(true);
    seedOld();
    expect(migrationFailed(run())).toBe(false);
    expect(newItems()).toEqual([MIGRATION_MARKER]);
    // The stray old copies are cleaned up, not adopted.
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(false);
  });

  it("leaves everything else in the old folder alone, including Local State, which holds the token's key", () => {
    seedOld();
    write(path.join(from, "Local State"), '{"os_crypt":{"encrypted_key":"abc"}}');
    write(path.join(from, "logs", "main.log"), "log line");
    write(path.join(from, "GPUCache", "data_0"), "cache");
    run();
    expect(nodeFs.readFileSync(path.join(from, "Local State"), "utf8")).toBe('{"os_crypt":{"encrypted_key":"abc"}}');
    expect(nodeFs.readFileSync(path.join(from, "logs", "main.log"), "utf8")).toBe("log line");
    expect(nodeFs.existsSync(path.join(from, "GPUCache", "data_0"))).toBe(true);
    expect(newItems()).toEqual([...MIGRATED_ITEMS, MIGRATION_MARKER].sort());
  });

  it("is a no-op once committed", () => {
    seedOld();
    run();
    expect(run().every((r) => r.outcome === "absent")).toBe(true);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
  });

  it("never brings an old copy back after a failed delete, even after the new token is revoked and removed", () => {
    seedOld();
    run();
    const locked = fsWith({
      rmSync: ((target: string, options?: nodeFs.RmOptions) => {
        if (String(target).startsWith(from)) throw fsError("EBUSY");
        nodeFs.rmSync(target, options);
      }) as MigrationFs["rmSync"],
    });
    const logs: string[] = [];
    expect(migrationFailed(run({ fs: locked, log: (m) => logs.push(m) }))).toBe(false);
    expect(logs.join("\n")).toContain("still could not be removed");
    expect(nodeFs.existsSync(path.join(from, "relay-token.bin"))).toBe(true);

    // The cloud revokes this PC, and the app deletes the new token.
    nodeFs.rmSync(path.join(to, "relay-token.bin"));
    expect(migrationFailed(run())).toBe(false);
    expect(nodeFs.existsSync(path.join(to, "relay-token.bin"))).toBe(false);
    // The leftover is cleaned up, never imported again.
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(false);
    expect(tree(path.join(to, "spool"))).toEqual(SPOOL_FILES);
  });

  it("finishes removing a half-deleted old spool on a later start without touching the new one", () => {
    seedOld();
    run();
    const partial = fsWith({
      rmSync: ((target: string, options?: nodeFs.RmOptions) => {
        if (String(target) === path.join(from, "spool")) {
          nodeFs.rmSync(path.join(from, "spool", "job-1.json"), { force: true });
          throw fsError("EBUSY");
        }
        nodeFs.rmSync(target, options);
      }) as MigrationFs["rmSync"],
    });
    expect(migrationFailed(run({ fs: partial }))).toBe(false);
    expect(tree(path.join(from, "spool"))).toEqual(["job-1.send", path.join("nested", "job-2.json")]);
    expect(tree(path.join(to, "spool"))).toEqual(SPOOL_FILES);
    run();
    expect(nodeFs.existsSync(path.join(from, "spool"))).toBe(false);
    expect(tree(path.join(to, "spool"))).toEqual(SPOOL_FILES);
  });

  it("retries the removal of an old copy Windows reports as briefly busy", () => {
    seedOld();
    run();
    let busy = 1;
    const slept: number[] = [];
    const flaky = fsWith({
      rmSync: ((target: string, options?: nodeFs.RmOptions) => {
        if (String(target) === path.join(from, "relay-token.bin") && busy > 0) {
          busy -= 1;
          throw fsError("EBUSY");
        }
        nodeFs.rmSync(target, options);
      }) as MigrationFs["rmSync"],
    });
    migrateWindowsSupportData({ from, to, fs: flaky, sleep: (ms) => void slept.push(ms) });
    expect(slept).toEqual([100]);
    expect(nodeFs.existsSync(path.join(from, "relay-token.bin"))).toBe(false);
  });

  it("treats a zero-byte marker as committed and imports nothing", () => {
    seedOld();
    write(path.join(to, MIGRATION_MARKER), "");
    expect(newItems()).toEqual([MIGRATION_MARKER]);
    expect(migrationFailed(run())).toBe(false);
    expect(newItems()).toEqual([MIGRATION_MARKER]);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(false);
  });

  it("imports nothing when the marker exists but the new items are gone, and still removes the leftovers", () => {
    seedOld();
    run();
    for (const item of MIGRATED_ITEMS) nodeFs.rmSync(path.join(to, item), { recursive: true, force: true });
    expect(migrationFailed(run())).toBe(false);
    expect(newItems()).toEqual([MIGRATION_MARKER]);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(false);
  });

  it("is all or nothing: one item that cannot be copied stops the others, and nothing is committed", () => {
    seedOld();
    const failing = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        if (String(file).includes("relay-token.bin")) throw fsError("ENOSPC");
        nodeFs.writeFileSync(file, data);
      }) as MigrationFs["writeFileSync"],
    });
    const logs: string[] = [];
    const results = run({ fs: failing, log: (m) => logs.push(m) });
    expect(outcomes(results)).toEqual({ "prefs.json": "failed", "relay-token.bin": "failed", spool: "failed" });
    expect(migrationFailed(results)).toBe(true);
    expect(tree(to)).toEqual([]);
    expect(hasMarker()).toBe(false);
    expect(nodeFs.readFileSync(path.join(from, "relay-token.bin")).equals(token)).toBe(true);
    expect(nodeFs.existsSync(path.join(from, "prefs.json"))).toBe(true);
    expect(tree(path.join(from, "spool"))).toHaveLength(3);
    // The code is logged so support can tell the failures apart. A path or message never is.
    expect(logs.join("\n")).toContain("ENOSPC");
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("discards a copy that does not read back identically and commits nothing", () => {
    seedOld();
    const truncating = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => nodeFs.writeFileSync(file, Buffer.from(data).subarray(0, 3))) as MigrationFs["writeFileSync"],
    });
    const results = run({ fs: truncating });
    expect(migrationFailed(results)).toBe(true);
    expect(tree(to)).toEqual([]);
    expect(hasMarker()).toBe(false);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
  });

  it("finishes on the next start after staging debris from a crash, and never keeps a partial copy", () => {
    seedOld();
    let writes = 0;
    const crashing = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        writes += 1;
        nodeFs.writeFileSync(file, data);
        if (writes === 3) throw fsError("EIO");
      }) as MigrationFs["writeFileSync"],
    });
    expect(migrationFailed(run({ fs: crashing }))).toBe(true);
    // A crash that skips the cleanup altogether leaves debris behind.
    write(path.join(to, "spool.migrating", "job-1.json"), "partial");
    write(path.join(to, "spool.migrating", "stray-from-a-crash.json"), "must not survive");
    write(path.join(to, "relay-token.bin.migrating"), "partial token");
    expect(hasMarker()).toBe(false);

    expect(outcomes(run())).toEqual({ "prefs.json": "moved", "relay-token.bin": "moved", spool: "moved" });
    expect(tree(path.join(to, "spool"))).toEqual(SPOOL_FILES);
    expect(nodeFs.readFileSync(path.join(to, "spool", "job-1.json"), "utf8")).toBe('{"state":"ambiguous"}');
    expect(newItems()).toEqual([...MIGRATED_ITEMS, MIGRATION_MARKER].sort());
  });

  it("after a crash between renames, the half-placed set loses to the newer old copy on the next start", () => {
    seedOld();
    let renames = 0;
    const crashing = fsWith({
      renameSync: ((a: string, b: string) => {
        renames += 1;
        // Every attempt after the first item fails, so the retries cannot get past it either.
        if (renames >= 2) throw fsError("EPERM");
        nodeFs.renameSync(a, b);
      }) as MigrationFs["renameSync"],
      // Antivirus is holding the freshly placed file, so the rollback fails too.
      rmSync: ((target: string, options?: nodeFs.RmOptions) => {
        if (String(target) === path.join(to, "prefs.json")) throw fsError("EPERM");
        nodeFs.rmSync(target, options);
      }) as MigrationFs["rmSync"],
    });
    expect(migrationFailed(run({ fs: crashing }))).toBe(true);
    expect(nodeFs.existsSync(path.join(to, "prefs.json"))).toBe(true);
    expect(hasMarker()).toBe(false);

    // The failed launch ran on the old folder, and the user changed the paired printer there.
    nodeFs.writeFileSync(path.join(from, "prefs.json"), '{"pairedUsbSerial":"D9J200100002"}');

    expect(migrationFailed(run())).toBe(false);
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"D9J200100002"}');
    expect(hasMarker()).toBe(true);
  });

  it("removes uncommitted items left in the new folder, including stale files inside a half-placed spool", () => {
    seedOld();
    write(path.join(to, "spool", "stale-from-an-uncommitted-attempt.json"), "must not survive");
    write(path.join(to, "prefs.json"), '{"pairedUsbSerial":"UNCOMMITTED"}');
    expect(hasMarker()).toBe(false);
    expect(migrationFailed(run())).toBe(false);
    expect(tree(path.join(to, "spool"))).toEqual(SPOOL_FILES);
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"D9J200100001"}');
  });

  it("never commits a revoked token that was left in the new folder by an attempt that could not roll back", () => {
    seedOld();
    const stuck = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        if (String(file).endsWith(MIGRATION_MARKER)) throw fsError("ENOSPC");
        nodeFs.writeFileSync(file, data);
      }) as MigrationFs["writeFileSync"],
      // Antivirus holds the freshly placed token, so the rollback cannot remove it.
      rmSync: ((target: string, options?: nodeFs.RmOptions) => {
        if (String(target) === path.join(to, "relay-token.bin")) throw fsError("EBUSY");
        nodeFs.rmSync(target, options);
      }) as MigrationFs["rmSync"],
    });
    expect(migrationFailed(run({ fs: stuck }))).toBe(true);
    expect(nodeFs.existsSync(path.join(to, "relay-token.bin"))).toBe(true);
    expect(hasMarker()).toBe(false);

    // The failed launch ran on the old folder. The cloud revoked the PC, which deleted the old token.
    nodeFs.rmSync(path.join(from, "relay-token.bin"));
    nodeFs.writeFileSync(path.join(from, "prefs.json"), '{"revoked":true}');

    expect(migrationFailed(run())).toBe(false);
    expect(hasMarker()).toBe(true);
    expect(nodeFs.existsSync(path.join(to, "relay-token.bin"))).toBe(false);
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"revoked":true}');
  });

  it("also clears uncommitted debris when there is nothing left to move", () => {
    write(path.join(to, "relay-token.bin"), "debris");
    write(path.join(to, "spool", "stale.json"), "debris");
    expect(migrationFailed(run())).toBe(false);
    expect(newItems()).toEqual([MIGRATION_MARKER]);
  });

  it("fails closed, and never commits or deletes, when the old folder cannot be inspected", () => {
    seedOld();
    const unreachable = fsWith({
      statSync: ((target: string, options?: unknown) => {
        if (String(target).startsWith(from)) throw fsError("EACCES");
        return (nodeFs.statSync as (t: string, o?: unknown) => nodeFs.Stats)(target, options);
      }) as MigrationFs["statSync"],
    });
    const logs: string[] = [];
    const results = run({ fs: unreachable, log: (m) => logs.push(m) });
    expect(migrationFailed(results)).toBe(true);
    expect(hasMarker()).toBe(false);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
    expect(logs.join("\n")).toContain("EACCES");
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("does not commit when the marker cannot be written, puts nothing in place, and keeps the old copies", () => {
    seedOld();
    const noMarker = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        if (String(file).endsWith(MIGRATION_MARKER)) throw fsError("EPERM");
        nodeFs.writeFileSync(file, data);
      }) as MigrationFs["writeFileSync"],
    });
    expect(migrationFailed(run({ fs: noMarker }))).toBe(true);
    expect(newItems()).toEqual([]);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
    expect(migrationFailed(run())).toBe(false);
  });

  it("retries a rename Windows reports as briefly busy, but not a failure that will not pass", () => {
    seedOld();
    let busy = 2;
    const slept: number[] = [];
    const flaky = fsWith({
      renameSync: ((a: string, b: string) => {
        if (busy > 0) {
          busy -= 1;
          throw fsError("EBUSY");
        }
        nodeFs.renameSync(a, b);
      }) as MigrationFs["renameSync"],
    });
    const results = migrateWindowsSupportData({ from, to, fs: flaky, sleep: (ms) => void slept.push(ms) });
    expect(migrationFailed(results)).toBe(false);
    expect(slept).toEqual([100, 200]);

    nodeFs.rmSync(root, { recursive: true, force: true });
    from = path.join(root, "Roaming", "Favor Printer");
    to = path.join(root, "Local", "Favor Printer");
    seedOld();
    let calls = 0;
    const full = fsWith({
      renameSync: (() => {
        calls += 1;
        throw fsError("ENOSPC");
      }) as MigrationFs["renameSync"],
    });
    expect(migrationFailed(migrateWindowsSupportData({ from, to, fs: full, sleep: noSleep }))).toBe(true);
    expect(calls).toBe(1);
  });

  it("stays on the local folder once committed even when an old leftover cannot be inspected, and still cleans the others", () => {
    seedOld();
    expect(migrationFailed(run())).toBe(false);
    const oldPrefs = path.join(from, "prefs.json");
    const pending = fsWith({
      statSync: ((target: string, options?: unknown) => {
        if (String(target) === oldPrefs) throw fsError("EPERM");
        return (nodeFs.statSync as (t: string, o?: unknown) => nodeFs.Stats)(target, options);
      }) as MigrationFs["statSync"],
    });
    const logs: string[] = [];
    expect(chooseSupportDir({ userDataDir: from, from, to, fs: pending, sleep: noSleep, log: (m) => logs.push(m) })).toBe(to);
    expect(nodeFs.existsSync(oldPrefs)).toBe(true);
    expect(nodeFs.existsSync(path.join(from, "relay-token.bin"))).toBe(false);
    expect(nodeFs.existsSync(path.join(from, "spool"))).toBe(false);
    expect(logs.join("\n")).toContain("EPERM");
    expect(logs.join("\n")).not.toContain("secret");
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
  });

  it("retries the marker check Windows reports as briefly busy instead of falling back to the old folder", () => {
    seedOld();
    expect(migrationFailed(run())).toBe(false);
    const marker = path.join(to, MIGRATION_MARKER);
    let busy = 2;
    const held = fsWith({
      statSync: ((target: string, options?: unknown) => {
        if (String(target) === marker && busy > 0) {
          busy -= 1;
          throw fsError(busy === 1 ? "EBUSY" : "EPERM");
        }
        return (nodeFs.statSync as (t: string, o?: unknown) => nodeFs.Stats)(target, options);
      }) as MigrationFs["statSync"],
    });
    expect(chooseSupportDir({ userDataDir: from, from, to, fs: held, sleep: noSleep })).toBe(to);
    expect(busy).toBe(0);
  });

  it("treats a marker that exists after its write reported an error as committed, and loses no data on the next start", () => {
    seedOld();
    const marker = path.join(to, MIGRATION_MARKER);
    const halfWritten = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        if (String(file) === marker) {
          nodeFs.writeFileSync(file, "");
          throw fsError("EIO");
        }
        nodeFs.writeFileSync(file, data);
      }) as MigrationFs["writeFileSync"],
    });
    expect(outcomes(run({ fs: halfWritten }))).toEqual({ "prefs.json": "moved", "relay-token.bin": "moved", spool: "moved" });
    expect(hasMarker()).toBe(true);
    expect(chooseSupportDir({ userDataDir: from, from, to, sleep: noSleep })).toBe(to);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
    expect(tree(path.join(to, "spool"))).toEqual([...SPOOL_FILES].sort());
    expect(MIGRATED_ITEMS.some((item) => nodeFs.existsSync(path.join(from, item)))).toBe(false);
  });

  it("removes a marker left by a failed write before discarding the copies, so the next start re-imports instead of deleting", () => {
    seedOld();
    const marker = path.join(to, MIGRATION_MARKER);
    let markerStats = 0;
    const flaky = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        if (String(file) === marker) {
          nodeFs.writeFileSync(file, "");
          throw fsError("EIO");
        }
        nodeFs.writeFileSync(file, data);
      }) as MigrationFs["writeFileSync"],
      statSync: ((target: string, options?: unknown) => {
        // The marker cannot be inspected after the failed write, only removed.
        if (String(target) === marker && nodeFs.existsSync(marker)) {
          markerStats += 1;
          throw fsError("EACCES");
        }
        return (nodeFs.statSync as (t: string, o?: unknown) => nodeFs.Stats)(target, options);
      }) as MigrationFs["statSync"],
    });
    expect(migrationFailed(run({ fs: flaky }))).toBe(true);
    expect(markerStats).toBeGreaterThan(0);
    expect(hasMarker()).toBe(false);
    expect(newItems()).toEqual([]);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
    expect(migrationFailed(run())).toBe(false);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
  });

  it("flushes every staged file before it is put in place, and the marker before the move counts as done", () => {
    seedOld();
    const open = new Map<number, string>();
    const flushed = new Set<string>();
    const order: string[] = [];
    const watched = fsWith({
      openSync: ((file: string, flags: string) => {
        const fd = nodeFs.openSync(file, flags);
        open.set(fd, String(file));
        return fd;
      }) as MigrationFs["openSync"],
      fsyncSync: ((fd: number) => {
        nodeFs.fsyncSync(fd);
        flushed.add(open.get(fd) ?? "");
        order.push(`fsync ${open.get(fd)}`);
      }) as MigrationFs["fsyncSync"],
      renameSync: ((a: string, b: string) => {
        const staged = nodeFs.statSync(a).isDirectory() ? tree(String(a)).map((rel) => path.join(String(a), rel)) : [String(a)];
        expect(staged.length).toBeGreaterThan(0);
        for (const file of staged) expect(flushed.has(file)).toBe(true);
        order.push(`rename ${a}`);
        nodeFs.renameSync(a, b);
      }) as MigrationFs["renameSync"],
    });
    expect(migrationFailed(run({ fs: watched }))).toBe(false);
    expect(flushed.has(path.join(to, MIGRATION_MARKER))).toBe(true);
    expect(order.at(-1)).toBe(`fsync ${path.join(to, MIGRATION_MARKER)}`);
    expect(order.filter((step) => step.startsWith("rename"))).toHaveLength(MIGRATED_ITEMS.length);
  });

  it("does nothing, and deletes nothing, when the new folder is a junction or symlink to the old one", () => {
    seedOld();
    nodeFs.mkdirSync(path.dirname(to), { recursive: true });
    nodeFs.symlinkSync(from, to, "junction");
    expect(migrateWindowsSupportData({ from, to, sleep: noSleep })).toEqual([]);
    expect(chooseSupportDir({ userDataDir: from, from, to, sleep: noSleep })).toBe(to);
    expect(tree(from)).toEqual(["prefs.json", "relay-token.bin", ...SPOOL_FILES.map((f) => path.join("spool", f))].sort());
    expect(nodeFs.existsSync(path.join(from, MIGRATION_MARKER))).toBe(false);
  });

  it("also sees through a linked parent folder", () => {
    // Local -> Roaming, so the new name reaches the old folder through its parent.
    seedOld();
    const local = path.join(root, "Local");
    nodeFs.symlinkSync(path.join(root, "Roaming"), local, "junction");
    expect(migrateWindowsSupportData({ from, to, sleep: noSleep })).toEqual([]);
    expect(nodeFs.readFileSync(path.join(from, "relay-token.bin")).equals(token)).toBe(true);
    expect(tree(path.join(from, "spool"))).toEqual([...SPOOL_FILES].sort());
  });

  it("deletes nothing when it cannot tell whether the two folders are the same", () => {
    seedOld();
    expect(migrationFailed(run())).toBe(false);
    seedOld();
    const unresolvable = fsWith({
      realpathSync: Object.assign(() => {
        throw fsError("EACCES");
      }, { native: () => {
        throw fsError("EACCES");
      } }) as unknown as MigrationFs["realpathSync"],
    });
    const logs: string[] = [];
    expect(chooseSupportDir({ userDataDir: from, from, to, fs: unresolvable, sleep: noSleep, log: (m) => logs.push(m) })).toBe(to);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
    expect(logs.join("\n")).toContain("EACCES");

    nodeFs.rmSync(to, { recursive: true, force: true });
    expect(migrationFailed(run({ fs: unresolvable }))).toBe(true);
    expect(nodeFs.existsSync(to)).toBe(false);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
  });

  it("does nothing when the old and new folders are the same", () => {
    seedOld();
    expect(migrateWindowsSupportData({ from, to: from, sleep: noSleep })).toEqual([]);
    expect(migrateWindowsSupportData({ from, to: from.toUpperCase(), sleep: noSleep })).toEqual([]);
    expect(nodeFs.existsSync(path.join(from, "prefs.json"))).toBe(true);
  });
});

describe("chooseSupportDir", () => {
  it("is the local folder once the move succeeded, and stays there on every later start", () => {
    seedOld();
    expect(chooseSupportDir({ userDataDir: from, from, to, sleep: noSleep })).toBe(to);
    expect(chooseSupportDir({ userDataDir: from, from, to, sleep: noSleep })).toBe(to);
  });

  it("is the old folder for the launch where the move failed, with all the data still there", () => {
    seedOld();
    const failing = fsWith({
      writeFileSync: (() => {
        throw fsError("EIO");
      }) as MigrationFs["writeFileSync"],
    });
    expect(chooseSupportDir({ userDataDir: from, from, to, fs: failing, sleep: noSleep })).toBe(from);
    expect(nodeFs.readFileSync(path.join(from, "relay-token.bin")).equals(token)).toBe(true);
    expect(chooseSupportDir({ userDataDir: from, from, to, sleep: noSleep })).toBe(to);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
  });
});
