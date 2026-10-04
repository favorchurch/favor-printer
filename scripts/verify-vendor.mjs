// Checks vendor/relay against its SOURCE.json: every listed file exists with the
// recorded sha256, nothing unlisted sits next to them, and the embedded relay
// entry (embedded.ts) and its index (index.ts) are present. vendor/relay is written
// only by the sync pull request from the RSVP repository, never by hand.
//
//   pnpm verify:vendor

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST = "SOURCE.json";

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

  if (typeof manifest?.repo !== "string" || manifest.repo === "") {
    problems.push(`${MANIFEST} has no repo`);
  }
  if (typeof manifest?.path !== "string" || manifest.path === "") {
    problems.push(`${MANIFEST} has no path`);
  }
  if (typeof manifest?.sha !== "string" || !GIT_SHA.test(manifest.sha)) {
    problems.push(`${MANIFEST} sha is not a 40-character commit sha`);
  }
  const files = manifest?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files) || Object.keys(files).length === 0) {
    problems.push(`${MANIFEST} has no files`);
    return { ok: false, problems };
  }

  for (const required of REQUIRED_FILES) {
    if (!(required in files)) problems.push(`${required} is not listed in ${MANIFEST}`);
  }

  for (const [name, expected] of Object.entries(files)) {
    if (!isSafeRelativePath(name)) {
      problems.push(`${name}: not a relative path inside vendor/relay`);
      continue;
    }
    if (typeof expected !== "string" || !SHA256.test(expected)) {
      problems.push(`${name}: recorded hash is not a sha256`);
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(path.join(dir, name));
    } catch {
      problems.push(`${name}: listed in ${MANIFEST} but missing on disk`);
      continue;
    }
    if (sha256(bytes) !== expected) problems.push(`${name}: hash differs from ${MANIFEST}`);
  }

  for (const name of await listFiles(dir)) {
    if (name !== MANIFEST && !(name in files)) problems.push(`${name}: on disk but not listed in ${MANIFEST}`);
  }

  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, problems } = await verifyVendor();
  if (ok) {
    console.log("vendor/relay matches SOURCE.json");
  } else {
    console.error("vendor/relay does not match SOURCE.json:");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("Do not edit vendor/relay by hand. Re-sync it from the RSVP repository.");
    process.exit(1);
  }
}
