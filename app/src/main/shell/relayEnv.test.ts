import { describe, expect, it, vi } from "vitest";

import {
  buildRelayEnv,
  createUtilityRelayForker,
  isStrippedEnvKey,
  relayEntryPath,
  relayForkOptions,
  RELAY_SERVICE_NAME,
  type UtilityProcessModule,
} from "./relayEnv";
import { createFakeChild } from "./testing/fakeChild";

const NOISY_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/volunteer",
  LANG: "en_AU.UTF-8",
  RELAY_API_URL: "https://example.test",
  RELAY_TOKEN: "leaked",
  RELAY_ID: "x",
  relay_spool_dir: "/tmp/lowercase",
  USB_SHIM_PORT: "9100",
  SIM_MODE: "sink",
  RELAYED_BY: "kept: only the RELAY_ prefix is removed",
  MISSING: undefined,
};

describe("buildRelayEnv", () => {
  it("removes every RELAY_*, USB_SHIM_* and SIM_* key, in any case", () => {
    const env = buildRelayEnv(NOISY_ENV);
    expect(Object.keys(env).filter((key) => /^(RELAY_|USB_SHIM_|SIM_)/i.test(key))).toEqual([]);
  });

  it("keeps everything else and drops undefined values", () => {
    expect(buildRelayEnv(NOISY_ENV)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/volunteer",
      LANG: "en_AU.UTF-8",
      RELAYED_BY: "kept: only the RELAY_ prefix is removed",
    });
  });

  it("does not modify the environment it reads", () => {
    const source = { ...NOISY_ENV };
    buildRelayEnv(source);
    expect(source).toEqual(NOISY_ENV);
  });

  it("classifies keys", () => {
    expect(["RELAY_X", "USB_SHIM_X", "SIM_X", "relay_x"].every(isStrippedEnvKey)).toBe(true);
    expect(["PATH", "SIMULATOR", "RELAYED"].some(isStrippedEnvKey)).toBe(false);
  });
});

describe("the fork the app makes in production", () => {
  it("passes exactly serviceName, env and stdio, with no RELAY_* key in env", () => {
    const fake = createFakeChild();
    const fork = vi.fn((..._args: Parameters<UtilityProcessModule["fork"]>) => fake.child);
    const forker = createUtilityRelayForker({
      utilityProcess: { fork },
      entry: "/Applications/Favor Printer.app/Contents/Resources/app.asar/dist/relay.js",
      processEnv: NOISY_ENV,
    });

    expect(forker()).toBe(fake.child);

    expect(fork).toHaveBeenCalledTimes(1);
    const [entry, args, options] = fork.mock.calls[0];
    expect(entry).toBe("/Applications/Favor Printer.app/Contents/Resources/app.asar/dist/relay.js");
    expect(args).toEqual([]);
    expect(options).toEqual({
      serviceName: RELAY_SERVICE_NAME,
      stdio: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/volunteer", LANG: "en_AU.UTF-8", RELAYED_BY: "kept: only the RELAY_ prefix is removed" },
    });
    expect(Object.keys(options).sort()).toEqual(["env", "serviceName", "stdio"]);
    expect(Object.keys(options.env).some((key) => /^(RELAY_|USB_SHIM_|SIM_)/i.test(key))).toBe(false);
    expect(JSON.stringify(options)).not.toContain("leaked");
  });

  it("reads the environment at fork time, so a restart picks up changes but still strips", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    const fork = vi.fn(() => createFakeChild().child);
    const forker = createUtilityRelayForker({ utilityProcess: { fork }, entry: "relay.js", processEnv: env });
    forker();
    env.RELAY_TOKEN = "late";
    env.EXTRA = "1";
    forker();
    const secondOptions = (fork.mock.calls[1] as unknown as Parameters<UtilityProcessModule["fork"]>)[2];
    expect(secondOptions.env).toEqual({ PATH: "/bin", EXTRA: "1" });
  });

  it("names the service so the process is identifiable", () => {
    expect(relayForkOptions({}).serviceName).toBe("Favor Printer relay");
  });
});

describe("relayEntryPath", () => {
  it("is dist/relay.js next to main.js", () => {
    expect(relayEntryPath("/app/dist")).toBe("/app/dist/relay.js");
  });
});
