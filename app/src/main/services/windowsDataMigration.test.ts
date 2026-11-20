import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATED_ITEMS, migrateWindowsSupportData, type MigrationFs } from "./windowsDataMigration";

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
  write(path.join(from, "spool", "nested", "job-2.json"), "{}");
}

const realFs: MigrationFs = {
  existsSync: nodeFs.existsSync,
  mkdirSync: nodeFs.mkdirSync,
  readdirSync: nodeFs.readdirSync,
  readFileSync: nodeFs.readFileSync,
  rmSync: nodeFs.rmSync,
  statSync: nodeFs.statSync,
  writeFileSync: nodeFs.writeFileSync,
};

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
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"D9J200100001"}');
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
    expect(nodeFs.readFileSync(path.join(to, "spool", "job-1.json"), "utf8")).toBe('{"state":"ambiguous"}');
    expect(nodeFs.readFileSync(path.join(to, "spool", "nested", "job-2.json"), "utf8")).toBe("{}");
    for (const item of MIGRATED_ITEMS) expect(nodeFs.existsSync(path.join(from, item))).toBe(false);
    expect(logs).toHaveLength(3);
    expect(logs.join("\n")).not.toContain("D9J200100001");
  });

  it("does nothing, and creates nothing, when there is no old data", () => {
    expect(migrateWindowsSupportData({ from, to })).toEqual(MIGRATED_ITEMS.map((item) => ({ item, outcome: "absent" })));
    expect(nodeFs.existsSync(to)).toBe(false);
  });

  it("leaves other files in the old folder alone", () => {
    seedOld();
    write(path.join(from, "logs", "main.log"), "log line");
    write(path.join(from, "GPUCache", "data_0"), "cache");
    migrateWindowsSupportData({ from, to });
    expect(nodeFs.readFileSync(path.join(from, "logs", "main.log"), "utf8")).toBe("log line");
    expect(nodeFs.existsSync(path.join(from, "GPUCache", "data_0"))).toBe(true);
    expect(nodeFs.existsSync(path.join(to, "logs"))).toBe(false);
  });

  it("is a no-op the second time", () => {
    seedOld();
    migrateWindowsSupportData({ from, to });
    expect(migrateWindowsSupportData({ from, to }).every((r) => r.outcome === "absent")).toBe(true);
    expect(nodeFs.readFileSync(path.join(to, "relay-token.bin")).equals(token)).toBe(true);
  });

  it("never overwrites an item that already exists at the new path, and keeps the old copy", () => {
    seedOld();
    write(path.join(to, "prefs.json"), '{"pairedUsbSerial":"NEWER"}');
    const results = migrateWindowsSupportData({ from, to });
    expect(results.find((r) => r.item === "prefs.json")?.outcome).toBe("kept-existing");
    expect(nodeFs.readFileSync(path.join(to, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"NEWER"}');
    expect(nodeFs.readFileSync(path.join(from, "prefs.json"), "utf8")).toBe('{"pairedUsbSerial":"D9J200100001"}');
    expect(results.find((r) => r.item === "relay-token.bin")?.outcome).toBe("moved");
  });

  it("keeps the old copy and discards the new one when the copy does not read back identically", () => {
    seedOld();
    const truncating: MigrationFs = {
      ...realFs,
      writeFileSync: ((file: string, data: string | Uint8Array) => nodeFs.writeFileSync(file, Buffer.from(data).subarray(0, 3))) as MigrationFs["writeFileSync"],
    };
    const results = migrateWindowsSupportData({ from, to, fs: truncating });
    expect(results.every((r) => r.outcome === "failed")).toBe(true);
    for (const item of MIGRATED_ITEMS) {
      expect(nodeFs.existsSync(path.join(from, item))).toBe(true);
      expect(nodeFs.existsSync(path.join(to, item))).toBe(false);
    }
    expect(nodeFs.readFileSync(path.join(from, "relay-token.bin")).equals(token)).toBe(true);
  });

  it("keeps the old copy and cleans up when writing fails part way, without stopping the other items", () => {
    seedOld();
    const failing: MigrationFs = {
      ...realFs,
      writeFileSync: ((file: string, data: string | Uint8Array) => {
        if (String(file).endsWith("relay-token.bin")) {
          nodeFs.writeFileSync(file, "partial");
          throw new Error("disk full");
        }
        nodeFs.writeFileSync(file, data);
      }) as MigrationFs["writeFileSync"],
    };
    const logs: string[] = [];
    const results = migrateWindowsSupportData({ from, to, fs: failing, log: (m) => logs.push(m) });
    expect(results.find((r) => r.item === "relay-token.bin")?.outcome).toBe("failed");
    expect(nodeFs.existsSync(path.join(to, "relay-token.bin"))).toBe(false);
    expect(nodeFs.readFileSync(path.join(from, "relay-token.bin")).equals(token)).toBe(true);
    expect(results.find((r) => r.item === "prefs.json")?.outcome).toBe("moved");
    expect(results.find((r) => r.item === "spool")?.outcome).toBe("moved");
    expect(logs.join("\n")).not.toContain("disk full");
  });

  it("does nothing when the old and new folders are the same", () => {
    seedOld();
    expect(migrateWindowsSupportData({ from, to: from })).toEqual([]);
    expect(migrateWindowsSupportData({ from, to: from.toUpperCase() })).toEqual([]);
    expect(nodeFs.existsSync(path.join(from, "prefs.json"))).toBe(true);
  });
});
