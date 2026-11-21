import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error -- plain .mjs signing hook without type declarations
import { buildSignArgs, DEV_DESCRIPTION, signWith } from "./sign.mjs";

const THUMB = "0123456789ABCDEF0123456789ABCDEF01234567";

describe("local dev-signing hook", () => {
  it("signs with SHA-256 from the CurrentUser store, selected by thumbprint, with no timestamp server", () => {
    const args: string[] = buildSignArgs({ thumbprint: THUMB, file: "C:\\x\\app.exe" });
    expect(args.slice(0, 3)).toEqual(["sign", "/sha1", THUMB]);
    expect(args).toContain("/fd");
    expect(args[args.indexOf("/fd") + 1]).toBe("sha256");
    expect(args[args.indexOf("/s") + 1]).toBe("My");
    expect(args).not.toContain("/tr");
    expect(args).not.toContain("/t");
    expect(args[args.indexOf("/d") + 1]).toBe(DEV_DESCRIPTION);
    expect(args.at(-1)).toBe("C:\\x\\app.exe");
  });

  it.each([undefined, "", "not-a-thumbprint", THUMB.slice(1), `${THUMB}0`, `${THUMB.slice(0, 39)}G`])(
    "refuses to sign without a well-formed thumbprint (%s)",
    (thumbprint) => {
      expect(() => buildSignArgs({ thumbprint, file: "a.exe" })).toThrow(/40-hex/);
    },
  );
});

describe("sign hook", () => {
  const SIGNTOOL = "C:\\sdk\\signtool.exe";
  const env = { FAVOR_DEV_SIGNTOOL: SIGNTOOL, FAVOR_DEV_SIGN_SHA1: THUMB };
  const config = { path: "C:\\x\\app.exe", hash: "sha256" };
  const ok = (_cmd?: string, _args?: string[]) => ({ status: 0, stdout: "", stderr: "" });

  it("runs signtool with the built arguments", () => {
    const spawn = vi.fn(ok);
    signWith(config, { env, exists: () => true, spawn });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][0]).toBe(SIGNTOOL);
    expect(spawn.mock.calls[0][1]).toEqual(buildSignArgs({ thumbprint: THUMB, file: config.path }));
  });

  it.each([
    ["missing", { FAVOR_DEV_SIGN_SHA1: THUMB }, true],
    ["empty", { ...env, FAVOR_DEV_SIGNTOOL: "" }, true],
    ["not on disk", env, false],
  ])("refuses when FAVOR_DEV_SIGNTOOL is %s", (_label, e, present) => {
    const spawn = vi.fn(ok);
    expect(() => signWith(config, { env: e, exists: () => present, spawn })).toThrow(/FAVOR_DEV_SIGNTOOL/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses an invalid thumbprint before running signtool", () => {
    const spawn = vi.fn(ok);
    expect(() =>
      signWith(config, { env: { ...env, FAVOR_DEV_SIGN_SHA1: "nope" }, exists: () => true, spawn }),
    ).toThrow(/40-hex/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("throws with signtool output when signtool exits non-zero", () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: "out", stderr: "SignTool Error: no cert" }));
    expect(() => signWith(config, { env, exists: () => true, spawn })).toThrow(/signtool failed \(1\).*\n.*SignTool Error/s);
  });

  it.each(["sha1", "SHA1"])("skips a non-SHA-256 pass (%s) without signing", (hash) => {
    const spawn = vi.fn(ok);
    expect(signWith({ ...config, hash }, { env, exists: () => true, spawn })).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([{ CI: "true" }, { GITHUB_ACTIONS: "true" }])("refuses to run in CI (%o)", (ci) => {
    const spawn = vi.fn(ok);
    expect(() => signWith(config, { env: { ...env, ...ci }, exists: () => true, spawn })).toThrow(/CI/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("signing config isolation", () => {
  const production = readFileSync("electron-builder.yml", "utf8");
  const dev = readFileSync("electron-builder.dev-signed.yml", "utf8").replace(/^\s*#.*$/gm, "");

  it("keeps the production config free of any signing identity", () => {
    expect(production).not.toMatch(/certificateSha1|certificateSubjectName|certificateFile|signtoolOptions/);
  });

  it("selects the dev certificate only through the environment, never a literal thumbprint", () => {
    expect(dev).toMatch(/^extends: \.\/electron-builder\.yml$/m);
    expect(dev).toMatch(/certificateSha1: "\$\{env\.FAVOR_DEV_SIGN_SHA1\}"/);
    expect(dev).not.toMatch(/[0-9A-Fa-f]{40}/);
    expect(dev).not.toMatch(/verifyUpdateCodeSignature/);
    expect(dev).not.toMatch(/^publish:/m);
  });

  it("names the artifact so it cannot be mistaken for a release installer", () => {
    expect(dev).toMatch(/DEV-SIGNED-LOCAL/);
  });
});
