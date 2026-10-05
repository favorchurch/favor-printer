import { describe, expect, it, vi } from "vitest";

import type { UpdateChannel, UpdateState } from "../../shared";
import { createFakeTimers } from "./testing/fakes";
import {
  CHECK_INTERVAL_MS,
  channelSettings,
  createUpdateController,
  installDecision,
  type UpdaterAdapter,
  type UpdaterEvent,
} from "./updates";

function setup(options: { channel?: UpdateChannel; check?: () => Promise<void> } = {}) {
  let listener: (event: UpdaterEvent) => void = () => undefined;
  const adapter: UpdaterAdapter = {
    configure: vi.fn(),
    subscribe: (next) => {
      listener = next;
    },
    check: vi.fn(options.check ?? (async () => undefined)),
    quitAndInstall: vi.fn(),
  };
  const fake = createFakeTimers();
  const states: UpdateState[] = [];
  const controller = createUpdateController({
    adapter,
    channel: options.channel ?? "stable",
    onState: (state) => states.push(state),
    timers: fake.timers,
  });
  return { adapter, controller, fake, states, emit: (event: UpdaterEvent) => listener(event) };
}

describe("channelSettings", () => {
  it("follows stable releases only on the stable channel", () => {
    expect(channelSettings("stable")).toEqual({ allowPrerelease: false, allowDowngrade: false });
  });

  it("follows prereleases on the preview channel, still never downgrading", () => {
    expect(channelSettings("preview")).toEqual({ allowPrerelease: true, allowDowngrade: false });
  });
});

describe("installDecision", () => {
  it.each([
    [{ updateReady: false, jobInFlight: false }, "none"],
    [{ updateReady: false, jobInFlight: true }, "none"],
    [{ updateReady: true, jobInFlight: false }, "install"],
    [{ updateReady: true, jobInFlight: true }, "defer"],
  ] as const)("%j -> %s", (input, decision) => {
    expect(installDecision(input)).toBe(decision);
  });
});

describe("check schedule", () => {
  it("configures the channel and listens before anything runs", () => {
    const { adapter } = setup({ channel: "preview" });
    expect(adapter.configure).toHaveBeenCalledWith({ allowPrerelease: true, allowDowngrade: false });
    expect(adapter.check).not.toHaveBeenCalled();
  });

  it("checks at launch and every 6 hours", () => {
    const { adapter, controller, fake } = setup();
    controller.start();
    expect(adapter.check).toHaveBeenCalledTimes(1);

    const intervals = [...fake.pending.values()].filter((timer) => timer.kind === "interval");
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(6 * 60 * 60 * 1000);
    expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);

    fake.fire("interval");
    fake.fire("interval");
    expect(adapter.check).toHaveBeenCalledTimes(3);
  });

  it("starts one interval however often it is started, and stop clears it", () => {
    const { controller, fake } = setup();
    controller.start();
    controller.start();
    expect(fake.pending.size).toBe(1);
    controller.stop();
    expect(fake.pending.size).toBe(0);
  });

  it("checks again when the channel changes", async () => {
    const { adapter, controller } = setup();
    await controller.setChannel("preview");
    expect(adapter.configure).toHaveBeenLastCalledWith({ allowPrerelease: true, allowDowngrade: false });
    expect(adapter.check).toHaveBeenCalledTimes(1);
  });
});

describe("update state", () => {
  it("follows the updater through check, download and ready", () => {
    const { controller, emit, states } = setup();
    expect(controller.state()).toEqual({ kind: "idle" });
    emit({ kind: "checking" });
    emit({ kind: "available" });
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(states).toEqual([{ kind: "checking" }, { kind: "downloading" }, { kind: "ready", version: "0.2.0" }]);
    expect(controller.state()).toEqual({ kind: "ready", version: "0.2.0" });
  });

  it("returns to idle when there is no update", () => {
    const { controller, emit } = setup();
    emit({ kind: "checking" });
    emit({ kind: "not-available" });
    expect(controller.state()).toEqual({ kind: "idle" });
  });

  it("reports a repeated state once", () => {
    const { emit, states } = setup();
    emit({ kind: "checking" });
    emit({ kind: "checking" });
    expect(states).toEqual([{ kind: "checking" }]);
  });

  it("turns a failed check into an error state and never throws", async () => {
    const { controller } = setup({
      check: async () => {
        throw new Error("net::ERR_INTERNET_DISCONNECTED");
      },
    });
    await expect(controller.checkNow()).resolves.toBeUndefined();
    expect(controller.state()).toEqual({ kind: "error" });
  });

  it("does not throw from the scheduled checks either", async () => {
    const { controller, fake } = setup({
      check: async () => {
        throw new Error("offline");
      },
    });
    controller.start();
    fake.fire("interval");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state()).toEqual({ kind: "error" });
  });

  it("keeps a downloaded update when a later check or download fails", () => {
    const { controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });
    emit({ kind: "checking" });
    emit({ kind: "error" });
    emit({ kind: "not-available" });
    expect(controller.state()).toEqual({ kind: "ready", version: "0.2.0" });
  });

  it("moves to a newer downloaded version", () => {
    const { controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });
    emit({ kind: "downloaded", version: "0.3.0" });
    expect(controller.state()).toEqual({ kind: "ready", version: "0.3.0" });
  });
});

describe("install deferral", () => {
  it("does nothing at quit when no update is downloaded", () => {
    const { adapter, controller } = setup();
    expect(controller.beforeQuit(false)).toBe("none");
    expect(controller.beforeQuit(true)).toBe("none");
    controller.jobsSettled();
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs at quit when an update is ready and no job is in flight", () => {
    const { adapter, controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(controller.beforeQuit(false)).toBe("install");
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("defers while a job is in flight and installs once it has finished", () => {
    const { adapter, controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });

    expect(controller.beforeQuit(true)).toBe("defer");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();

    controller.jobsSettled();
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
    controller.jobsSettled();
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not install when a job finishes and nobody asked to quit", () => {
    const { adapter, controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });
    controller.jobsSettled();
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });
});
