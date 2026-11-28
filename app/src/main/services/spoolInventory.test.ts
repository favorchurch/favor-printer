import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { propertyParams } from "../../shared/testing/property";
import { spoolAbsentOrEmpty } from "./spoolInventory";

const failingRead = (code: string | undefined) => () => {
  throw Object.assign(new Error(`read failed: ${code ?? "no code"}`), { code });
};

describe("spoolAbsentOrEmpty on a real folder", () => {
  let root: string;
  let spool: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "spool-inventory-"));
    spool = path.join(root, "spool");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is true when the folder is absent, and does not create it", () => {
    expect(spoolAbsentOrEmpty(spool)).toBe(true);
    expect(existsSync(spool)).toBe(false);
  });

  it("is true for an empty folder, and leaves it empty", () => {
    mkdirSync(spool);
    expect(spoolAbsentOrEmpty(spool)).toBe(true);
    expect(readdirSync(spool)).toEqual([]);
  });

  it.each([
    ["a job record", "job-1.json"],
    ["a send marker", "job-1.send"],
    ["a temp file", "job-1.json.4242.0a1b2c.tmp"],
    ["the relay lock", ".relay.lock"],
    ["a quarantined record", "job-2.json.corrupt"],
    ["an unknown file", "notes.txt"],
    ["a dotfile", ".DS_Store"],
  ])("is false with %s in it, and leaves it there", (_label, file) => {
    mkdirSync(spool);
    writeFileSync(path.join(spool, file), "{}");
    expect(spoolAbsentOrEmpty(spool)).toBe(false);
    expect(readdirSync(spool)).toEqual([file]);
  });

  it("is false with a subfolder in it", () => {
    mkdirSync(path.join(spool, "nested"), { recursive: true });
    expect(spoolAbsentOrEmpty(spool)).toBe(false);
  });

  it("is false when the spool path is a file, not a folder", () => {
    writeFileSync(spool, "x");
    expect(spoolAbsentOrEmpty(spool)).toBe(false);
  });
});

describe("spoolAbsentOrEmpty with a failing read", () => {
  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR", "EMFILE", undefined])("is false when the read fails with %s", (code) => {
    expect(spoolAbsentOrEmpty("/spool", failingRead(code))).toBe(false);
  });

  it("is true only when the folder does not exist", () => {
    expect(spoolAbsentOrEmpty("/spool", failingRead("ENOENT"))).toBe(true);
  });

  it("reads the folder it was given, once, and nothing else", () => {
    const list = vi.fn(() => []);
    spoolAbsentOrEmpty("/a/spool", list);
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith("/a/spool");
  });
});

describe("spoolAbsentOrEmpty properties", () => {
  it("is true exactly when the listing has no names", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }), (names) => {
        expect(spoolAbsentOrEmpty("/spool", () => names)).toBe(names.length === 0);
      }),
      propertyParams(300),
    );
  });

  it("is false for every read error code except ENOENT", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((code) => code !== "ENOENT"), (code) => {
        expect(spoolAbsentOrEmpty("/spool", failingRead(code))).toBe(false);
      }),
      propertyParams(300),
    );
  });
});
