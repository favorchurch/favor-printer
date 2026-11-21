/**
 * electron-builder custom `sign` hook for the LOCAL, DEV-ONLY Windows signing path (issue #42).
 *
 * Used only through electron-builder.dev-signed.yml. It signs one file with the Windows SDK
 * SignTool and a certificate that already lives in the CurrentUser\My store, selected by
 * thumbprint from the environment. Nothing here embeds a certificate, thumbprint or key, and
 * it never touches a trust store. There is no timestamp: the signature is for a disposable,
 * short-lived DEV ONLY test certificate and is not a release signature.
 *
 * It refuses to run when CI or GITHUB_ACTIONS is set, so it can never sign in a pipeline.
 *
 * Environment (set by scripts/dev-signing/Build-DevSigned.ps1):
 *   FAVOR_DEV_SIGN_SHA1      thumbprint of the DEV ONLY certificate (40 hex chars)
 *   FAVOR_DEV_SIGNTOOL       absolute path to the Windows SDK signtool.exe
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const DEV_DESCRIPTION = "Favor Printer DEV ONLY";

export function buildSignArgs({ thumbprint, file }) {
  if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint ?? "")) throw new Error("FAVOR_DEV_SIGN_SHA1 must be a 40-hex certificate thumbprint");
  return ["sign", "/sha1", thumbprint, "/s", "My", "/fd", "sha256", "/d", DEV_DESCRIPTION, file];
}

/** Testable core of the hook; `deps` replaces the environment, existsSync and spawnSync. */
export function signWith(configuration, { env = process.env, exists = existsSync, spawn = spawnSync } = {}) {
  if (env.CI || env.GITHUB_ACTIONS) throw new Error("DEV ONLY signing refuses to run in CI (CI or GITHUB_ACTIONS is set)");
  if (configuration.hash && configuration.hash.toLowerCase() !== "sha256") return; // SHA-256 only
  const signtool = env.FAVOR_DEV_SIGNTOOL;
  if (!signtool || !exists(signtool)) throw new Error("FAVOR_DEV_SIGNTOOL must point at the Windows SDK signtool.exe");
  const args = buildSignArgs({ thumbprint: env.FAVOR_DEV_SIGN_SHA1, file: configuration.path });
  const result = spawn(signtool, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`signtool failed (${result.status}) for ${configuration.path}\n${result.stdout}${result.stderr}`);
  }
}

// electron-builder calls the hook as (configuration, packager); the packager is not used.
export default async function sign(configuration) {
  signWith(configuration);
}
