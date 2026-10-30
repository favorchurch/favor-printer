import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs release script without type declarations
import { verifyWindowsRelease } from "./verify-windows-release.mjs";

const VERSION = "1.2.3-beta.4";
const EXE = `Favor-Printer-${VERSION}-x64-unsigned-preview.exe`;
const dirs: string[] = [];

function build(change: { manifestName?: string; version?: string; sha?: string; blockmap?: boolean; helper?: string; extra?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "favor-win-release-"));
  dirs.push(dir);
  const exe = Buffer.from("MZ installer bytes");
  writeFileSync(path.join(dir, EXE), exe);
  if (change.blockmap !== false) writeFileSync(path.join(dir, `${EXE}.blockmap`), "blockmap");
  const sha = change.sha ?? createHash("sha512").update(exe).digest("base64");
  writeFileSync(
    path.join(dir, change.manifestName ?? "beta.yml"),
    `version: ${change.version ?? VERSION}\nfiles:\n  - url: ${EXE}\n    sha512: ${sha}\n    size: ${exe.length}\npath: ${EXE}\nsha512: ${sha}\nreleaseDate: '2026-10-30T00:00:00.000Z'\n`,
  );
  if (change.extra) writeFileSync(path.join(dir, change.extra), "version: x\n");
  const resources = path.join(dir, "win-unpacked", "resources", "windows");
  mkdirSync(resources, { recursive: true });
  for (const helper of ["probe-printers.ps1", "print-raw.ps1"]) {
    const source = readFileSync(path.join("scripts", "windows", helper));
    writeFileSync(path.join(resources, helper), helper === change.helper ? Buffer.concat([source, Buffer.from("# tampered\n")]) : source);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("verifyWindowsRelease", () => {
  it("accepts a beta build whose manifest matches the installer and whose helpers are the reviewed scripts", () => {
    const result = verifyWindowsRelease({ dir: build(), channel: "beta", version: VERSION });
    expect(result).toMatchObject({ manifest: "beta.yml", installer: EXE });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a manifest for the other channel, so a Preview build never feeds stable clients", () => {
    expect(() => verifyWindowsRelease({ dir: build({ manifestName: "latest.yml" }), channel: "beta", version: VERSION })).toThrow(/beta\.yml/);
    expect(() => verifyWindowsRelease({ dir: build(), channel: "latest", version: VERSION })).toThrow(/latest\.yml/);
    expect(() => verifyWindowsRelease({ dir: build({ extra: "latest.yml" }), channel: "beta", version: VERSION })).toThrow(/exactly/);
  });

  it("refuses a wrong version, a wrong hash or a missing blockmap", () => {
    expect(() => verifyWindowsRelease({ dir: build({ version: "1.2.3-beta.3" }), channel: "beta", version: VERSION })).toThrow(/version/);
    expect(() => verifyWindowsRelease({ dir: build({ sha: "AAAA" }), channel: "beta", version: VERSION })).toThrow(/sha512/);
    expect(() => verifyWindowsRelease({ dir: build({ blockmap: false }), channel: "beta", version: VERSION })).toThrow(/blockmap/);
  });

  it("refuses a packaged PowerShell helper that differs from the reviewed source", () => {
    for (const helper of ["probe-printers.ps1", "print-raw.ps1"]) {
      expect(() => verifyWindowsRelease({ dir: build({ helper }), channel: "beta", version: VERSION })).toThrow(helper);
    }
  });
});
