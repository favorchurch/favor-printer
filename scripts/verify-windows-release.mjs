#!/usr/bin/env node
/**
 * Verify a Windows release build before it is uploaded (issue #42).
 *
 *   node scripts/verify-windows-release.mjs --dir release --channel beta --version 1.2.3-beta.4
 *
 * Fails unless:
 *   - the directory holds exactly one Windows update manifest, named for the channel
 *     (latest.yml for stable, beta.yml for Preview);
 *   - the manifest names the tag's version and an installer that exists, with the
 *     installer's real sha512 and size, and its blockmap is present;
 *   - the PowerShell helpers inside the packaged app are byte-identical to the
 *     reviewed scripts/windows sources.
 * Prints the installer's sha256 for the release notes and checksum file.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const HELPERS = ["probe-printers.ps1", "print-raw.ps1"];

export function verifyWindowsRelease({ dir, channel, version, sourceDir = path.join("scripts", "windows") }) {
  if (!["latest", "beta"].includes(channel)) throw new Error(`unsupported channel ${channel}`);
  const manifests = readdirSync(dir).filter((name) => /^(latest|beta|alpha)\.yml$/.test(name));
  if (manifests.length !== 1 || manifests[0] !== `${channel}.yml`) {
    throw new Error(`expected exactly ${channel}.yml in ${dir}, found: ${manifests.join(", ") || "none"}`);
  }
  const text = readFileSync(path.join(dir, manifests[0]), "utf8");
  const field = (name) => new RegExp(`^${name}: ['"]?([^'"\\r\\n]+)['"]?\\r?$`, "m").exec(text)?.[1];
  if (field("version") !== version) throw new Error(`manifest version ${field("version")} is not ${version}`);
  const installer = field("path");
  const sha512 = field("sha512");
  if (!installer || !/^[\w.-]+\.exe$/.test(installer) || !sha512) throw new Error("manifest lacks a plain installer path or sha512");
  const file = path.join(dir, installer);
  if (!existsSync(file)) throw new Error(`manifest names missing installer ${installer}`);
  const bytes = readFileSync(file);
  if (createHash("sha512").update(bytes).digest("base64") !== sha512) throw new Error("manifest sha512 does not match the installer");
  const size = /^\s+size: (\d+)\r?$/m.exec(text)?.[1];
  if (size !== undefined && Number(size) !== statSync(file).size) throw new Error("manifest size does not match the installer");
  if (!existsSync(`${file}.blockmap`)) throw new Error(`missing ${installer}.blockmap`);
  for (const helper of HELPERS) {
    const shipped = readFileSync(path.join(dir, "win-unpacked", "resources", "windows", helper));
    if (!shipped.equals(readFileSync(path.join(sourceDir, helper)))) throw new Error(`bundled ${helper} differs from ${sourceDir}`);
  }
  return { manifest: manifests[0], installer, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const arg = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`missing --${name}`);
    return process.argv[index + 1];
  };
  try {
    const result = verifyWindowsRelease({ dir: arg("dir"), channel: arg("channel"), version: arg("version") });
    console.log(`${result.manifest} -> ${result.installer} verified (sha256 ${result.sha256})`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
