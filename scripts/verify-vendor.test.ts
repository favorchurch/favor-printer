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
const hashes = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)]));

const FILES: Record<string, string> = {
  "embedded.ts": "export const embedded = true;\n",
  "index.ts": "export const index = true;\n",
  "relay.ts": "export const relay = true;\n",
};

let dir: string;

async function writeManifest(fields: { sha?: string; files: Record<string, string> }) {
  await writeFile(
    path.join(dir, "SOURCE.json"),
    JSON.stringify({ repo: "favorchurch/rsvp.favor.church", path: "relay", sha: SHA, ...fields }),
  );
}

async function writeSnapshot(files: Record<string, string>, manifestFiles?: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  await writeManifest({ files: manifestFiles ?? hashes(files) });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "verify-vendor-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifyVendor", () => {
  it("accepts a snapshot whose files match their recorded hashes", async () => {
    await writeSnapshot(FILES);
    expect(await verify({ dir })).toEqual({ ok: true, problems: [] });
  });

  it("fails when embedded.ts is missing from disk and from the manifest", async () => {
    await writeSnapshot(without(FILES, "embedded.ts"));
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("embedded.ts is not listed in SOURCE.json");
  });

  it("fails when embedded.ts is listed but deleted from disk", async () => {
    await writeSnapshot(FILES);
    await rm(path.join(dir, "embedded.ts"));
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("embedded.ts: listed in SOURCE.json but missing on disk");
  });

  it("fails when index.ts is missing", async () => {
    await writeSnapshot(without(FILES, "index.ts"));
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("index.ts is not listed in SOURCE.json");
  });

  it("fails when a file's contents drift from the recorded hash", async () => {
    await writeSnapshot(FILES);
    await writeFile(path.join(dir, "relay.ts"), "export const relay = 'edited by hand';\n");
    const result = await verify({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["relay.ts: hash differs from SOURCE.json"]);
  });

  it("fails on a file that is not listed in the manifest", async () => {
    await writeSnapshot(FILES);
    await writeFile(path.join(dir, "extra.ts"), "export {};\n");
    const result = await verify({ dir });
    expect(result.problems).toEqual(["extra.ts: on disk but not listed in SOURCE.json"]);
  });

  it("checks files in subdirectories", async () => {
    await writeSnapshot({ ...FILES, "lib/util.ts": "export const util = 1;\n" });
    await writeFile(path.join(dir, "lib", "util.ts"), "export const util = 2;\n");
    const result = await verify({ dir });
    expect(result.problems).toEqual(["lib/util.ts: hash differs from SOURCE.json"]);
  });

  it("fails when SOURCE.json is missing", async () => {
    await writeFile(path.join(dir, "embedded.ts"), FILES["embedded.ts"] ?? "");
    expect(await verify({ dir })).toEqual({ ok: false, problems: ["SOURCE.json is missing"] });
  });

  it("fails when SOURCE.json is not JSON", async () => {
    await writeFile(path.join(dir, "SOURCE.json"), "{ not json");
    expect(await verify({ dir })).toEqual({ ok: false, problems: ["SOURCE.json is not valid JSON"] });
  });

  it("rejects a sha that is not a full commit sha and a hash that is not sha256", async () => {
    await writeSnapshot(FILES);
    await writeManifest({ sha: "main", files: { ...hashes(FILES), "relay.ts": "abc" } });
    const result = await verify({ dir });
    expect(result.problems).toContain("SOURCE.json sha is not a 40-character commit sha");
    expect(result.problems).toContain("relay.ts: recorded hash is not a sha256");
  });

  it("rejects manifest paths that escape the directory", async () => {
    await writeSnapshot(FILES, { ...hashes(FILES), "../outside.ts": sha("x") });
    const result = await verify({ dir });
    expect(result.problems).toContain("../outside.ts: not a relative path inside vendor/relay");
  });
});

describe("the committed vendor/relay snapshot", () => {
  it("matches its SOURCE.json and carries embedded.ts and index.ts", async () => {
    const result = await verifyVendor();
    expect(result).toEqual({ ok: true, problems: [] });
  });
});
