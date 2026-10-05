import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APP_ID, PRODUCT_NAME, RELEASE_OWNER, RELEASE_REPO, isEnrollmentCode, isUpdateChannel } from "./constants";
import { IPC_CHANNELS } from "./ipc";

const builderConfig = readFileSync(new URL("../../../electron-builder.yml", import.meta.url), "utf8");
const entitlements = readFileSync(new URL("../../../build/entitlements.mac.plist", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  main: string;
  devDependencies: Record<string, string>;
};

describe("shared constants match the packaging config", () => {
  it("uses the same app id, product name and release repository", () => {
    expect(builderConfig).toMatch(new RegExp(`^appId: ${APP_ID.replaceAll(".", "\\.")}$`, "m"));
    expect(builderConfig).toMatch(new RegExp(`^productName: ${PRODUCT_NAME}$`, "m"));
    expect(builderConfig).toMatch(new RegExp(`^  owner: ${RELEASE_OWNER}$`, "m"));
    expect(builderConfig).toMatch(new RegExp(`^  repo: ${RELEASE_REPO}$`, "m"));
  });

  it("is a menu-bar app with the hardened runtime and no app sandbox", () => {
    expect(builderConfig).toMatch(/^ {4}LSUIElement: true$/m);
    expect(builderConfig).toMatch(/^ {2}hardenedRuntime: true$/m);
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    expect(keys.sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ]);
  });

  it("keeps the packaged entry in step with the build output", () => {
    expect(pkg.main).toBe("dist/main.js");
  });

  it("pins every build tool to an exact version", () => {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      expect(version, name).toMatch(/^(npm:.+@)?\d+\.\d+\.\d+$/);
    }
  });
});

describe("isEnrollmentCode", () => {
  it("accepts exactly six digits", () => {
    expect(isEnrollmentCode("123456")).toBe(true);
    expect(isEnrollmentCode("000000")).toBe(true);
  });

  it.each(["", "12345", "1234567", "12345a", " 123456", "123456\n", "١٢٣٤٥٦", 123456, null, undefined])(
    "rejects %j",
    (value) => {
      expect(isEnrollmentCode(value)).toBe(false);
    },
  );
});

describe("isUpdateChannel", () => {
  it("accepts stable and preview only", () => {
    expect(isUpdateChannel("stable")).toBe(true);
    expect(isUpdateChannel("preview")).toBe(true);
    expect(isUpdateChannel("beta")).toBe(false);
    expect(isUpdateChannel(undefined)).toBe(false);
  });
});

describe("IPC_CHANNELS", () => {
  it("has unique, namespaced channel names", () => {
    const names = Object.values(IPC_CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^favor-printer:[a-z-]+$/);
  });
});
