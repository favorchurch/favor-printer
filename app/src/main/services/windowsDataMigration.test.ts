import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATED_ITEMS, migrateWindowsSupportData, migrationFailed, type MigrationFs } from "./windowsDataMigration";

let root: string;
let from: string;
let to: string;
const token = Buffer.from([0x01, 0x00, 0x00, 0x00, 0xd0, 0x8c, 0x9d, 0xdf, 0x00, 0xff, 0x10]);

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
  existsSync: nodeFs.existsSync,
  mkdirSync: nodeFs.mkdirSync,
  readdirSync: nodeFs.readdirSync,
  readFileSync: nodeFs.readFileSync,
  renameSync: nodeFs.renameSync,
  rmSync: nodeFs.rmSync,
  statSync: nodeFs.statSync,
  writeFileSync: nodeFs.writeFileSync,
};
const fsWith = (over: Partial<MigrationFs>): MigrationFs => ({ ...realFs, ...over });

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

beforeEach(() => {
  root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "favor-printer-migrate-"));
  from = path.join(root, "Roaming", "Favor Printer");
  to = path.join(root, "Local", "Favor Printer");
});

afterEach(() => nodeFs.rmSync(root, { recursive: true, force: true }));

describe("migrateWindowsSupportData", () => {
  it("moves the preferences, the token and the whole spool, byte for byte, and removes the old copies", () => {
    seedOld();
    const logs: string[] = [];
    const results = migrateWindowsSupportData({ from, to, log: (m) => logs.push(m) });
    expect(results).toEqual(MIGRATED_ITEMS.map((item) => ({ item, outcome: "moved" })));
    expect(migrationFailed(results)).toBe(false);
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"D9J200100001"}');
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
    expect(tree(path.join(to, "spool"))).toEqual(["job-1.json", "job-1.send", path.join("nested", "job-2.json")]);
    expect(nodeFs.readFileSync(path.join(to, "spool", "job-1.send"), "utf8")).toBe("marker");
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(false);
    expect(nodeFs.readdirSync(to).sort()).toEqual([...MIGRATED_ITEMS].sort());
    expect(logs.join("\n")).not.toContain("D9J200100001");
  });

  it("does nothing, and creates nothing, when there is no old data", () => {
    const results = migrateWindowsSupportData({ from, to });
    expect(results).toEqual(MIGRATED_ITEMS.map((item) => ({ item, outcome: "absent" })));
    expect(nodeFs.existsSync(to)).toBe(false);
  });

  it("leaves everything else in the old folder alone, including Local State, which holds the token's key", () => {
    seedOld();
    write(path.join(from, "Local State"), '{"os_crypt":{"encrypted_key":"abc"}}');
    write(path.join(from, "logs", "main.log"), "log line");
    write(path.join(from, "GPUCache", "data_0"), "cache");
    migrateWindowsSupportData({ from, to });
    expect(nodeFs.readFileSync(path.join(from, "Local State"), "utf8")).toBe('{"os_crypt":{"encrypted_key":"abc"}}');
    expect(nodeFs.readFileSync(path.join(from, "logs", "main.log"), "utf8")).toBe("log line");
    expect(nodeFs.existsSync(path.join(from, "GPUCache", "data_0"))).toBe(true);
    expect(nodeFs.readdirSync(to).sort()).toEqual([...MIGRATED_ITEMS].sort());
  });

  it("is a no-op the second time", () => {
    seedOld();
    migrateWindowsSupportData({ from, to });
    expect(migrateWindowsSupportData({ from, to }).every((r) => r.outcome === "absent")).toBe(true);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
  });

  it("never overwrites an item that already exists at the new path, and keeps that item's old copy", () => {
    seedOld();
    write(path.join(to, "prefs.json"), '{"pairedUsbSerial":"NEWER"}');
    write(path.join(to, "relay-token.bin"), "newer-token");
    const results = migrateWindowsSupportData({ from, to });
    expect(outcomes(results)).toEqual({ "prefs.json": "kept-existing", "relay-token.bin": "kept-existing", spool: "moved" });
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"NEWER"}');
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin"), "utf8")).toBe("newer-token");
    expect(nodeFs.existsSync(path.join(from, "prefs.json"))).toBe(true);
    expect(nodeFs.existsSync(path.join(from, "relay-token.bin"))).toBe(true);
  });

  it("is all or nothing: one item that cannot be copied stops the others from moving", () => {
    seedOld();
    const failing = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        if (String(file).includes("relay-token.bin")) throw new Error("disk full: C:\\secret\\path");
        nodeFs.writeFileSync(file, data);
      }) as MigrationFs["writeFileSync"],
    });
    const logs: string[] = [];
    const results = migrateWindowsSupportData({ from, to, fs: failing, log: (m) => logs.push(m) });
    expect(outcomes(results)).toEqual({ "prefs.json": "failed", "relay-token.bin": "failed", spool: "failed" });
    expect(migrationFailed(results)).toBe(true);
    expect(tree(to)).toEqual([]);
    expect(nodeFs.readFileSync(path.join(from, "relay-token.bin")).equals(token)).toBe(true);
    expect(nodeFs.existsSync(path.join(from, "prefs.json"))).toBe(true);
    expect(tree(path.join(from, "spool"))).toHaveLength(3);
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("discards a copy that does not read back identically and moves nothing", () => {
    seedOld();
    const truncating = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => nodeFs.writeFileSync(file, Buffer.from(data).subarray(0, 3))) as MigrationFs["writeFileSync"],
    });
    const results = migrateWindowsSupportData({ from, to, fs: truncating });
    expect(migrationFailed(results)).toBe(true);
    expect(tree(to)).toEqual([]);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
  });

  it("never leaves a partial new copy after a crash part way through, and finishes on the next start", () => {
    seedOld();
    let writes = 0;
    const crashing = fsWith({
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        writes += 1;
        nodeFs.writeFileSync(file, data);
        if (writes === 3) throw new Error("killed");
      }) as MigrationFs["writeFileSync"],
    });
    expect(migrationFailed(migrateWindowsSupportData({ from, to, fs: crashing }))).toBe(true);
    // A crash that skips the cleanup altogether: staging debris is left behind.
    write(path.join(to, "spool.migrating", "job-1.json"), "partial");
    write(path.join(to, "spool.migrating", "stray-from-a-crash.json"), "must not survive");
    write(path.join(to, "relay-token.bin.migrating"), "partial token");
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(to, item))).toBe(false);

    const results = migrateWindowsSupportData({ from, to });
    expect(outcomes(results)).toEqual({ "prefs.json": "moved", "relay-token.bin": "moved", spool: "moved" });
    expect(tree(path.join(to, "spool"))).toEqual(["job-1.json", "job-1.send", path.join("nested", "job-2.json")]);
    expect(nodeFs.readFileSync(path.join(to, "spool", "job-1.json"), "utf8")).toBe('{"state":"ambiguous"}');
    expect(nodeFs.readdirSync(to).sort()).toEqual([...MIGRATED_ITEMS].sort());
  });

  it("puts nothing in place and keeps the old copies when a rename fails after another succeeded", () => {
    seedOld();
    let renames = 0;
    const flaky = fsWith({
      renameSync: ((a: string, b: string) => {
        renames += 1;
        if (renames === 2) throw new Error("EPERM");
        nodeFs.renameSync(a, b);
      }) as MigrationFs["renameSync"],
    });
    const results = migrateWindowsSupportData({ from, to, fs: flaky });
    expect(migrationFailed(results)).toBe(true);
    expect(tree(to)).toEqual([]);
    expect(nodeFs.readdirSync(to)).toEqual([]);
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
  });

  it("keeps the verified new copy when the old copy cannot be removed", () => {
    seedOld();
    const locked = fsWith({
      rmSync: ((target: string, options?: nodeFs.RmOptions) => {
        if (String(target).startsWith(from) && String(target).endsWith("spool")) throw new Error("EBUSY");
        nodeFs.rmSync(target, options);
      }) as MigrationFs["rmSync"],
    });
    const logs: string[] = [];
    const results = migrateWindowsSupportData({ from, to, fs: locked, log: (m) => logs.push(m) });
    expect(migrationFailed(results)).toBe(false);
    expect(outcomes(results)).toEqual({ "prefs.json": "moved", "relay-token.bin": "moved", spool: "moved" });
    expect(tree(path.join(to, "spool"))).toEqual(["job-1.json", "job-1.send", path.join("nested", "job-2.json")]);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
    expect(logs.join("\n")).toContain("old copy could not be removed");
    // The next start sees the complete new copy and leaves it alone.
    expect(outcomes(migrateWindowsSupportData({ from, to }))).toMatchObject({ spool: "kept-existing" });
    expect(tree(path.join(to, "spool"))).toHaveLength(3);
  });

  it("does nothing when the old and new folders are the same", () => {
    seedOld();
    expect(migrateWindowsSupportData({ from, to: from })).toEqual([]);
    expect(migrateWindowsSupportData({ from, to: from.toUpperCase() })).toEqual([]);
    expect(nodeFs.existsSync(path.join(from, "prefs.json"))).toBe(true);
  });
});
