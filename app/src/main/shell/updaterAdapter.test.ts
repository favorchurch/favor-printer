import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createFakeTimers } from "../services/testing/fakes";
import { channelSettings, createUpdateController, type UpdaterEvent } from "../services";
import { createUpdaterAdapter, safeVersion, type AutoUpdaterLike } from "./updaterAdapter";

function fakeUpdater(check: () => Promise<unknown> = async () => null) {
  const listeners = new Map<string, (...args: never[]) => void>();
  let channel: string | null = null;
  const updater: AutoUpdaterLike = {
    // Like electron-updater: setting a channel turns downgrades on.
    get channel() {
      return channel;
    },
    set channel(value) {
      channel = value ?? null;
      this.allowDowngrade = true;
    },
    allowPrerelease: false,
    allowDowngrade: true,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: null,
    on: (event, listener) => void listeners.set(event, listener),
    checkForUpdates: vi.fn(check),
    quitAndInstall: vi.fn(),
  };
  return { updater, emit: (event: string, ...args: unknown[]) => (listeners.get(event) as (...a: unknown[]) => void)(...args) };
}

function setup(check?: () => Promise<unknown>) {
  const fake = fakeUpdater(check);
  const lines: string[] = [];
  const adapter = createUpdaterAdapter(fake.updater, (level, scope, message) => void lines.push(`${level} ${scope} ${message}`));
  return { ...fake, adapter, lines };
}

describe("createUpdaterAdapter", () => {
  it("downloads in the background but never installs on its own", () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it.each(["stable", "preview"] as const)("sets allowPrerelease for the %s channel and never allows a downgrade", (channel) => {
    const { adapter, updater } = setup();
    adapter.configure(channelSettings(channel));
    expect(updater.allowPrerelease).toBe(channel === "preview");
    expect(updater.allowDowngrade).toBe(false);
  });

  describe("channel", () => {
    it("leaves a Stable client with no custom channel", () => {
      const { adapter, updater } = setup();
      adapter.configure(channelSettings("stable"));
      expect(updater.channel).toBeNull();
      expect(updater.allowPrerelease).toBe(false);
      expect(updater.allowDowngrade).toBe(false);
    });

    it("puts Preview on beta, and turns downgrades back off after the channel setter turned them on", () => {
      const { adapter, updater } = setup();
      adapter.configure(channelSettings("preview"));
      expect(updater.channel).toBe("beta");
      expect(updater.allowPrerelease).toBe(true);
      expect(updater.allowDowngrade).toBe(false);
    });

    it("moves back to Stable by naming the default channel, because a set channel cannot be cleared", () => {
      const { adapter, updater } = setup();
      adapter.configure(channelSettings("preview"));
      adapter.configure(channelSettings("stable"));
      expect(updater.channel).toBe("latest");
      expect(updater.allowPrerelease).toBe(false);
      expect(updater.allowDowngrade).toBe(false);
    });

    it("can switch back and forth without ever allowing a downgrade", () => {
      const { adapter, updater } = setup();
      for (const channel of ["preview", "stable", "preview", "stable", "preview"] as const) {
        adapter.configure(channelSettings(channel));
        expect(updater.allowDowngrade).toBe(false);
        expect(updater.allowPrerelease).toBe(channel === "preview");
      }
      expect(updater.channel).toBe("beta");
    });
  });

  it("maps the updater's events", () => {
    const { adapter, emit } = setup();
    const events: UpdaterEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    emit("checking-for-update");
    emit("update-available", { version: "0.2.0" });
    emit("update-not-available");
    emit("update-downloaded", { version: "0.2.0" });
    emit("error", new Error("boom"));

    expect(events).toEqual([
      { kind: "checking" },
      { kind: "available" },
      { kind: "not-available" },
      { kind: "downloaded", version: "0.2.0" },
      { kind: "error" },
    ]);
  });

  it("copes with a downloaded event that carries no version", () => {
    const { adapter, emit } = setup();
    const events: UpdaterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    emit("update-downloaded", undefined);
    expect(events).toEqual([{ kind: "downloaded", version: "" }]);
  });

  it.each([
    ["0.2.0", "0.2.0"],
    ["1.12.3-preview.4", "1.12.3-preview.4"],
    ["1.0.0+build.5", "1.0.0+build.5"],
    ["Jane Q. Attendee", ""],
    ["1.2.3 ^XA^FDJane^XZ", ""],
    ["1.2", ""],
    ["", ""],
    [undefined, ""],
    [{}, ""],
  ])("shows the version %j as %j", (input, expected) => {
    expect(safeVersion(input)).toBe(expected);
  });

  it("checks through the updater and installs with a relaunch", async () => {
    const { adapter, updater } = setup();
    await adapter.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    adapter.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("lets a failed check reject, so the policy can mark it as an error", async () => {
    const { adapter } = setup(async () => {
      throw new Error("offline");
    });
    await expect(adapter.check()).rejects.toThrow("offline");
  });

  describe("logging", () => {
    it("logs an error as one line with secrets removed", () => {
      const { adapter, emit, lines } = setup();
      adapter.subscribe(() => undefined);
      emit("error", new Error("401 Bearer abcdef0123456789abcdef0123456789 from https://api.github.com/repos/x?access_token=ghp_secretvalue"));
      const text = lines.join("\n");
      expect(text).toContain("error updater");
      expect(text).not.toContain("abcdef0123456789abcdef0123456789");
      expect(text).not.toContain("ghp_secretvalue");
      expect(lines).toHaveLength(1);
    });

    it("routes the updater's own logger through the same redaction", () => {
      const { updater, lines } = setup();
      updater.logger?.error(new Error("token=hunter2 rejected"));
      updater.logger?.warn("code 123456 expired");
      updater.logger?.info("chatty");
      const text = lines.join("\n");
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("123456");
      expect(text).not.toContain("chatty");
    });
  });
});

describe("install gating by the update policy", () => {
  function policy() {
    const fake = fakeUpdater();
    const adapter = createUpdaterAdapter(fake.updater, () => undefined);
    const timers = createFakeTimers();
    const controller = createUpdateController({ adapter, channel: "preview", timers: timers.timers });
    return { ...fake, controller };
  }

  it("configures the channel from the saved preference", () => {
    expect(policy().updater.allowPrerelease).toBe(true);
  });

  it("installs at quit when an update is ready and no job is in flight", () => {
    const { controller, emit, updater } = policy();
    emit("update-downloaded", { version: "0.2.0" });
    expect(controller.beforeQuit(false)).toBe("install");
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("holds the install while a job is in flight, then installs when it settles", () => {
    const { controller, emit, updater } = policy();
    emit("update-downloaded", { version: "0.2.0" });
    expect(controller.beforeQuit(true)).toBe("defer");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    controller.jobsSettled();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does nothing at quit when no update was downloaded, and never auto installs", () => {
    const { controller, updater } = policy();
    expect(controller.beforeQuit(false)).toBe("none");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("keeps printing when an update check fails", async () => {
    const fake = fakeUpdater(async () => {
      throw new Error("offline");
    });
    const adapter = createUpdaterAdapter(fake.updater, () => undefined);
    const controller = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
    await controller.checkNow();
    expect(controller.state()).toEqual({ kind: "error" });
  });
});

describe("pinned electron-updater 6.8.9", () => {
  it("is pinned exactly in package.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies["electron-updater"]).toBe("6.8.9");
  });

  it("keeps autoInstallOnAppQuit false through configure, channel changes and every updater event", async () => {
    const fake = fakeUpdater();
    const adapter = createUpdaterAdapter(fake.updater, () => undefined);
    const controller = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
    expect(fake.updater.autoInstallOnAppQuit).toBe(false);

    for (const event of ["checking-for-update", "update-available", "update-not-available"]) fake.emit(event);
    fake.emit("update-downloaded", { version: "0.2.0" });
    fake.emit("error", new Error("boom"));
    await controller.setChannel("preview");
    await controller.checkNow();
    controller.start();
    controller.stop();

    expect(fake.updater.autoInstallOnAppQuit).toBe(false);
    expect(fake.updater.autoDownload).toBe(true);
  });

  it("does not install a downloaded update on its own, only when the quit path asks while idle", async () => {
    const fake = fakeUpdater();
    const adapter = createUpdaterAdapter(fake.updater, () => undefined);
    const controller = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });

    fake.emit("update-downloaded", { version: "0.2.0" });
    await controller.checkNow();
    await controller.setChannel("preview");
    controller.jobsSettled();
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();

    expect(controller.beforeQuit(false)).toBe("install");
    expect(fake.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("does not install from the quit path while a job is in flight", () => {
    const fake = fakeUpdater();
    const adapter = createUpdaterAdapter(fake.updater, () => undefined);
    const controller = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
    fake.emit("update-downloaded", { version: "0.2.0" });
    expect(controller.beforeQuit(true)).toBe("defer");
    expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("is the quit path that calls it: index.ts quits through the coordinator, never through quitAndInstall directly", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/quitAndInstall/);
    expect(source).toMatch(/createQuitCoordinator\(/);
    expect(source).toMatch(/autoUpdater as unknown as AutoUpdaterLike/);
  });
});
