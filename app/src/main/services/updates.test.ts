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

function setup(
  options: {
    channel?: UpdateChannel;
    check?: () => Promise<void>;
    now?: () => Date;
    onChecked?: (checkedAt: string) => void;
    noRelayEmptySpool?: () => boolean;
  } = {},
) {
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
    now: options.now,
    onChecked: options.onChecked,
  });
  if (options.noRelayEmptySpool) controller.setNoRelayEmptySpool(options.noRelayEmptySpool);
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
    [{ updateReady: false, jobInFlight: false, pendingEntries: 0, reconciliation: "complete" }, "none"],
    [{ updateReady: false, jobInFlight: true, pendingEntries: 0, reconciliation: "complete" }, "none"],
    [{ updateReady: false, jobInFlight: false, pendingEntries: 3, reconciliation: "complete" }, "none"],
    [{ updateReady: true, jobInFlight: false, pendingEntries: 0, reconciliation: "complete" }, "install"],
    [{ updateReady: true, jobInFlight: true, pendingEntries: 0, reconciliation: "complete" }, "defer"],
    [{ updateReady: true, jobInFlight: false, pendingEntries: 1, reconciliation: "complete" }, "defer"],
    [{ updateReady: true, jobInFlight: true, pendingEntries: 2, reconciliation: "complete" }, "defer"],
  ] as const)("%j -> %s", (input, decision) => {
    expect(installDecision({ noRelayEmptySpool: false, ...input })).toBe(decision);
  });

  it.each([
    [{ updateReady: true, jobInFlight: false, pendingEntries: 0, reconciliation: "pending" }, "install"],
    [{ updateReady: true, jobInFlight: true, pendingEntries: 0, reconciliation: "pending" }, "defer"],
    [{ updateReady: true, jobInFlight: false, pendingEntries: 1, reconciliation: "pending" }, "defer"],
    [{ updateReady: true, jobInFlight: false, pendingEntries: 0, reconciliation: "complete" }, "install"],
    [{ updateReady: false, jobInFlight: false, pendingEntries: 0, reconciliation: "pending" }, "none"],
  ] as const)("with no relay and an empty spool, %j -> %s", (input, decision) => {
    expect(installDecision({ noRelayEmptySpool: true, ...input })).toBe(decision);
  });

  it("keeps the reconciliation rule when the check is false: pending defers even with nothing else in the way", () => {
    expect(installDecision({ updateReady: true, jobInFlight: false, pendingEntries: 0, reconciliation: "pending", noRelayEmptySpool: false })).toBe("defer");
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

describe("last successful check", () => {
  function timed() {
    let at = "2026-11-24T15:00:00.000Z";
    const seen: string[] = [];
    const harness = setup({ now: () => new Date(at), onChecked: (checkedAt) => seen.push(checkedAt) });
    return { ...harness, seen, setNow: (value: string) => void (at = value) };
  }

  it("is null until a check gets an answer", () => {
    const { controller, emit, seen } = timed();
    expect(controller.lastCheckedAt()).toBeNull();
    emit({ kind: "checking" });
    emit({ kind: "error" });
    expect(controller.lastCheckedAt()).toBeNull();
    expect(seen).toEqual([]);
  });

  it.each<[string, UpdaterEvent]>([
    ["no update", { kind: "not-available" }],
    ["an update found", { kind: "available", version: "0.2.0" }],
    ["an update downloaded", { kind: "downloaded", version: "0.2.0" }],
  ])("records the time when the answer is %s", (_name, event) => {
    const { controller, emit, seen } = timed();
    emit(event);
    expect(controller.lastCheckedAt()).toBe("2026-11-24T15:00:00.000Z");
    expect(seen).toEqual(["2026-11-24T15:00:00.000Z"]);
  });

  it("moves forward on each answer, and a later failure keeps the last good time", () => {
    const { controller, emit, setNow } = timed();
    emit({ kind: "not-available" });
    setNow("2026-11-24T21:00:00.000Z");
    emit({ kind: "not-available" });
    expect(controller.lastCheckedAt()).toBe("2026-11-24T21:00:00.000Z");
    setNow("2026-11-25T03:00:00.000Z");
    emit({ kind: "error" });
    expect(controller.lastCheckedAt()).toBe("2026-11-24T21:00:00.000Z");
  });

  it("still records an answer while a downloaded update stays offered", () => {
    const { controller, emit, setNow } = timed();
    emit({ kind: "downloaded", version: "0.2.0" });
    setNow("2026-11-24T21:00:00.000Z");
    emit({ kind: "not-available" });
    expect(controller.state()).toEqual({ kind: "ready", version: "0.2.0" });
    expect(controller.lastCheckedAt()).toBe("2026-11-24T21:00:00.000Z");
  });
});

describe("update state", () => {
  it("follows the updater through check, download and ready", () => {
    const { controller, emit, states } = setup();
    expect(controller.state()).toEqual({ kind: "idle" });
    emit({ kind: "checking" });
    emit({ kind: "available", version: "0.2.0" });
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(states).toEqual([{ kind: "checking" }, { kind: "downloading", version: "0.2.0" }, { kind: "ready", version: "0.2.0" }]);
    expect(controller.state()).toEqual({ kind: "ready", version: "0.2.0" });
  });

  it("carries the available version through downloading and ready", () => {
    const { controller, emit } = setup();
    emit({ kind: "available", version: "0.3.0-beta.5" });
    expect(controller.state()).toEqual({ kind: "downloading", version: "0.3.0-beta.5" });
    emit({ kind: "downloaded", version: "0.3.0-beta.5" });
    expect(controller.state()).toEqual({ kind: "ready", version: "0.3.0-beta.5" });
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

describe("install with no relay and an empty spool", () => {
  it("installs a ready update at quit when reconciliation is pending, because no relay reports it", () => {
    const { adapter, controller, emit } = setup({ noRelayEmptySpool: () => true });
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(controller.beforeQuit(false, 0, "pending")).toBe("install");
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("defers while a job is in flight, then installs once it has settled", () => {
    const { adapter, controller, emit } = setup({ noRelayEmptySpool: () => true });
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(controller.beforeQuit(true, 0, "pending")).toBe("defer");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    controller.jobsSettled(false, 0, "pending");
    controller.jobsSettled(false, 0, "pending");
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("defers while an entry is pending, then installs once it is recorded", () => {
    const { adapter, controller, emit } = setup({ noRelayEmptySpool: () => true });
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(controller.beforeQuit(false, 1, "pending")).toBe("defer");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    controller.jobsSettled(false, 0, "pending");
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("without the check, a pending reconciliation keeps the update deferred", () => {
    const { adapter, controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(controller.beforeQuit(false, 0, "pending")).toBe("defer");
    controller.jobsSettled(false, 0, "pending");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not read the check when no update is waiting", () => {
    const check = vi.fn(() => true);
    const { controller } = setup({ noRelayEmptySpool: check });
    controller.beforeQuit(false, 0, "pending");
    controller.jobsSettled(false, 0, "pending");
    expect(check).not.toHaveBeenCalled();
  });

  it("reads the check fresh at each decision, so a spool that fills after one answer defers the next", () => {
    let idle = true;
    const check = vi.fn(() => idle);
    const { adapter, controller, emit } = setup({ noRelayEmptySpool: check });
    emit({ kind: "downloaded", version: "0.2.0" });

    idle = false;
    expect(controller.beforeQuit(false, 0, "pending")).toBe("defer");
    idle = true;
    controller.jobsSettled(false, 0, "pending");

    expect(check).toHaveBeenCalledTimes(2);
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe("install deferral", () => {
  it("does nothing at quit when no update is downloaded", () => {
    const { adapter, controller } = setup();
    expect(controller.beforeQuit(false, 0, "complete")).toBe("none");
    expect(controller.beforeQuit(true, 0, "complete")).toBe("none");
    controller.jobsSettled(false, 0, "complete");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs at quit when an update is ready and no job is in flight", () => {
    const { adapter, controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });
    expect(controller.beforeQuit(false, 0, "complete")).toBe("install");
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("defers while a job is in flight and installs once it has finished", () => {
    const { adapter, controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });

    expect(controller.beforeQuit(true, 0, "complete")).toBe("defer");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();

    controller.jobsSettled(false, 0, "complete");
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
    controller.jobsSettled(false, 0, "complete");
    expect(adapter.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not install when a job finishes and nobody asked to quit", () => {
    const { adapter, controller, emit } = setup();
    emit({ kind: "downloaded", version: "0.2.0" });
    controller.jobsSettled(false, 0, "complete");
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });
});