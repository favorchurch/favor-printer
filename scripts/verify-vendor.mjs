// Checks vendor/relay against its MANIFEST.json (schema 1, written by
// scripts/sync-relay-to-favor-printer.mjs in the RSVP repository; it replaced the
// older SOURCE.json): every listed file exists with the recorded sha256 and byte
// size, nothing unlisted sits next to them, treeSha256 matches the listed files,
// and the embedded relay entry (embedded.ts) and its index (index.ts) are present.
// vendor/relay is written only by the sync pull request from the RSVP repository,
// never by hand.
//
//   pnpm verify:vendor

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST = "MANIFEST.json";
export const MANIFEST_SCHEMA = 1;
export const SOURCE_REPOSITORY = "favorchurch/rsvp.favor.church";
export const SOURCE_PATH = "relay";

/** The app forks embedded.ts, which imports index.ts. A snapshot without them cannot run. */
export const REQUIRED_FILES = ["embedded.ts", "index.ts"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function listFiles(dir, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await listFiles(dir, relative)));
    else found.push(relative);
  }
  return found;
}

const isSafeRelativePath = (name) =>
  name !== "" &&
  !path.posix.isAbsolute(name) &&
  !name.includes("\\") &&
  path.posix.normalize(name) === name &&
  !name.split("/").includes("..");

/**
 * Mirrors treeSha256 in buildManifest (rsvp scripts/sync-relay-to-favor-printer.mjs):
 * sha256 over "<path>\n<sha256>\n" for every entry, sorted by path.
 */
const treeSha256 = (entries) => {
  const tree = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    tree.update(`${entry.path}\n${entry.sha256}\n`);
  }
  return tree.digest("hex");
};

/**
 * @param {{ dir?: string }} options dir is the vendor/relay directory
 * @returns {Promise<{ ok: boolean, problems: string[] }>}
 */
export async function verifyVendor({ dir = path.join(repoRoot, "vendor", "relay") } = {}) {
  const problems = [];

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, MANIFEST), "utf8"));
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "is missing" : "is not valid JSON";
    return { ok: false, problems: [`${MANIFEST} ${reason}`] };
  }

  // Fail closed: a schema this checker does not know could mean anything.
  if (manifest?.schema !== MANIFEST_SCHEMA) {
    return { ok: false, problems: [`${MANIFEST} schema is ${JSON.stringify(manifest?.schema)}, expected ${MANIFEST_SCHEMA}`] };
  }

  const source = manifest.source;
  if (source?.repository !== SOURCE_REPOSITORY) {
    problems.push(`${MANIFEST} source.repository is not ${SOURCE_REPOSITORY}`);
  }
  if (source?.path !== SOURCE_PATH) {
    problems.push(`${MANIFEST} source.path is not ${SOURCE_PATH}`);
  }
  if (typeof source?.commit !== "string" || !GIT_SHA.test(source.commit)) {
    problems.push(`${MANIFEST} source.commit is not a 40-character commit sha`);
  }
  if (typeof manifest.treeSha256 !== "string" || !SHA256.test(manifest.treeSha256)) {
    problems.push(`${MANIFEST} treeSha256 is not a sha256`);
  }
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    problems.push(`${MANIFEST} has no files`);
    return { ok: false, problems };
  }

  const listed = new Set();
  const wellFormed = [];
  for (const entry of files) {
    const name = entry?.path;
    if (typeof name !== "string" || !isSafeRelativePath(name)) {
      problems.push(`${String(name)}: not a relative path inside vendor/relay`);
      continue;
    }
    if (listed.has(name)) {
      problems.push(`${name}: listed more than once in ${MANIFEST}`);
      continue;
    }
    listed.add(name);
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      problems.push(`${name}: recorded hash is not a sha256`);
      continue;
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      problems.push(`${name}: recorded size is not a byte count`);
      continue;
    }
    wellFormed.push(entry);

    let bytes;
    try {
      bytes = await readFile(path.join(dir, name));
    } catch {
      problems.push(`${name}: listed in ${MANIFEST} but missing on disk`);
      continue;
    }
    if (sha256(bytes) !== entry.sha256) problems.push(`${name}: hash differs from ${MANIFEST}`);
    if (bytes.length !== entry.bytes) problems.push(`${name}: size differs from ${MANIFEST}`);
  }

  for (const required of REQUIRED_FILES) {
    if (!listed.has(required)) problems.push(`${required} is not listed in ${MANIFEST}`);
  }

  // Only meaningful when every entry parsed; otherwise the entry problem is already reported.
  if (wellFormed.length === files.length && SHA256.test(manifest.treeSha256 ?? "")) {
    if (treeSha256(wellFormed) !== manifest.treeSha256) {
      problems.push(`${MANIFEST} treeSha256 does not match the listed files`);
    }
  }

  for (const name of await listFiles(dir)) {
    if (name !== MANIFEST && !listed.has(name)) problems.push(`${name}: on disk but not listed in ${MANIFEST}`);
  }

  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, problems } = await verifyVendor();
  if (ok) {
    console.log("vendor/relay matches MANIFEST.json");
  } else {
    console.error("vendor/relay does not match MANIFEST.json:");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("Do not edit vendor/relay by hand. Re-sync it from the RSVP repository.");
    process.exit(1);
  }
}
