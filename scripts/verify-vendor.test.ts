import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without type declarations
import { verifyVendor } from "./verify-vendor.mjs";

type Result = { ok: boolean; problems: string[] };
const verify = verifyVendor as (options: { dir: string }) => Promise<Result>;

const SHA = "a".repeat(40);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const without = (files: Record<string, string>, name: string) =>
  Object.fromEntries(Object.entries(files).filter(([file]) => file !== name));

type Entry = { path: string; sha256: string; bytes: number };
const entriesOf = (files: Record<string, string>): Entry[] =>
  Object.entries(files)
    .map(([name, text]) => ({ path: name, sha256: sha(text), bytes: Buffer.byteLength(text) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
// Same recipe as buildManifest in the RSVP sync script.
const treeOf = (entries: Entry[]) => {
  const tree = createHash("sha256");
  for (const entry of entries) tree.update(`${entry.path}\n${entry.sha256}\n`);
  return tree.digest("hex");
};

const FILES: Record<string, string> = {
  "embedded.ts": "export const embedded = true;\n",
  "index.ts": "export const index = true;\n",
  "relay.ts": "export const relay = true;\n",
};

let dir: string;

async function writeManifest(fields: Record<string, unknown> & { files: Entry[] }) {
  await writeFile(
    path.join(dir, "MANIFEST.json"),
    JSON.stringify({
      schema: 1,
      source: { repository: "favorchurch/rsvp.favor.church", path: "relay", commit: SHA },
      entryPoints: ["embedded.ts", "index.ts"],
      treeSha256: treeOf(fields.files),
      ...fields,
    }),
  );
}

async function writeSnapshot(files: Record<string, string>, manifestFiles?: Entry[]) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  await writeManifest({ files: manifestFiles ?? entriesOf(files) });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verify-vendor-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifyVendor", () => {
  it("accepts a valid schema 1 manifest", async () => {
    await writeSnapshot(FILES);
    expect(await verify({ dir })).toEqual({ ok: true, problems: [] });
  });

  it("fails when embedded.ts is missing from disk and from the manifest", async () => {
    await writeSnapshot(without(FILES, "embedded.ts"));
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("embedded.ts is not listed in MANIFEST.json");
  });

  it("fails when embedded.ts is listed but deleted from disk", async () => {
    await writeSnapshot(FILES);
    await rm(path.join(dir, "embedded.ts"));
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("embedded.ts: listed in MANIFEST.json but missing on disk");
  });

  it("fails when index.ts is missing", async () => {
    await writeSnapshot(without(FILES, "index.ts"));
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("index.ts is not listed in MANIFEST.json");
  });

  it("fails on a tampered file with the same size", async () => {
    await writeSnapshot(FILES);
    await writeFile(path.join(dir, "relay.ts"), "export const relay = nope;\n");
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["relay.ts: hash differs from MANIFEST.json"]);
  });

  it("fails on a tampered file with a different size", async () => {
    await writeSnapshot(FILES);
    await writeFile(path.join(dir, "relay.ts"), "export const relay = 'edited by hand';\n");
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      "relay.ts: hash differs from MANIFEST.json",
      "relay.ts: size differs from MANIFEST.json",
    ]);
  });

  it("fails on an extra file that is not listed in the manifest", async () => {
    await writeSnapshot(FILES);
    await writeFile(path.join(dir, "extra.ts"), "export {};\n");
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["extra.ts: on disk but not listed in MANIFEST.json"]);
  });

  it("fails on a wrong treeSha256", async () => {
    await writeSnapshot(FILES);
    await writeManifest({ files: entriesOf(FILES), treeSha256: "0".repeat(64) });
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["MANIFEST.json treeSha256 does not match the listed files"]);
  });

  it("fails closed on an unknown schema", async () => {
    await writeSnapshot(FILES);
    await writeManifest({ files: entriesOf(FILES), schema: 2 });
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["MANIFEST.json schema is 2, expected 1"]);
  });

  it("fails closed on the old SOURCE.json format with no schema", async () => {
    await writeSnapshot(FILES);
    await writeFile(path.join(dir, "MANIFEST.json"), JSON.stringify({ repo: "favorchurch/rsvp.favor.church", sha: SHA, files: {} }));
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["MANIFEST.json schema is undefined, expected 1"]);
  });

  it("checks files in subdirectories", async () => {
    await writeSnapshot({ ...FILES, "lib/util.ts": "export const util = 1;\n" });
    await writeFile(path.join(dir, "lib", "util.ts"), "export const util = 2;\n");
    const result = await verify({ dir });
    expect(result.problems).toEqual(["lib/util.ts: hash differs from MANIFEST.json"]);
  });

  it("fails when MANIFEST.json is missing", async () => {
    await writeFile(path.join(dir, "embedded.ts"), FILES["embedded.ts"] ?? "");
    expect(await verify({ dir })).toEqual({ ok: false, problems: ["MANIFEST.json is missing"] });
  });

  it("fails when MANIFEST.json is not JSON", async () => {
    await writeFile(path.join(dir, "MANIFEST.json"), "{ not json");
    expect(await verify({ dir })).toEqual({ ok: false, problems: ["MANIFEST.json is not valid JSON"] });
  });

  it("rejects a wrong source repository, path and commit", async () => {
    await writeSnapshot(FILES);
    await writeManifest({ files: entriesOf(FILES), source: { repository: "someone/else", path: "other", commit: "main" } });
    const result = await verify({ dir });
    expect(result.problems).toEqual([
      "MANIFEST.json source.repository is not favorchurch/rsvp.favor.church",
      "MANIFEST.json source.path is not relay",
      "MANIFEST.json source.commit is not a 40-character commit sha",
    ]);
  });

  it("rejects a hash that is not sha256", async () => {
    await writeSnapshot(FILES);
    const entries = entriesOf(FILES).map((e) => (e.path === "relay.ts" ? { ...e, sha256: "abc" } : e));
    await writeManifest({ files: entries });
    const result = await verify({ dir });
    expect(result.problems).toContain("relay.ts: recorded hash is not a sha256");
  });

  it("rejects manifest paths that escape the directory", async () => {
    await writeSnapshot(FILES, [...entriesOf(FILES), { path: "../outside.ts", sha256: sha("x"), bytes: 1 }]);
    const result = await verify({ dir });
    expect(result.problems).toContain("../outside.ts: not a relative path inside vendor/relay");
  });
});

describe("the committed vendor/relay snapshot", () => {
  it("matches its MANIFEST.json and carries embedded.ts and index.ts", async () => {
    const result = await verifyVendor();
    expect(result).toEqual({ ok: true, problems: [] });
  });
});
