import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs signing hook without type declarations
import { buildSignArgs, DEV_DESCRIPTION } from "./sign.mjs";

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
