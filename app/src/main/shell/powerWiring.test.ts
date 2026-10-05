import { describe, expect, it, vi } from "vitest";

import { wirePowerMonitor, type PowerMonitorLike } from "./powerWiring";

function fakeMonitor(onBattery = false) {
  const listeners = new Map<string, () => void>();
  const monitor: PowerMonitorLike = {
    on: (event, listener) => void listeners.set(event, listener),
    removeListener: (event) => void listeners.delete(event),
    isOnBatteryPower: () => onBattery,
  };
  return { monitor, listeners, setBattery: (value: boolean) => (onBattery = value) };
}

function setup(onBattery = false) {
  const fake = fakeMonitor(onBattery);
  const controller = { setPowerContext: vi.fn(), refresh: vi.fn(async () => undefined) };
  const dispose = wirePowerMonitor(fake.monitor, controller);
  return { ...fake, controller, dispose, emit: (event: string) => fake.listeners.get(event)?.() };
}

describe("wirePowerMonitor", () => {
  it("reads the battery state at startup", () => {
    expect(setup(true).controller.setPowerContext).toHaveBeenCalledWith({ onBattery: true });
    expect(setup(false).controller.setPowerContext).toHaveBeenCalledWith({ onBattery: false });
  });

  it("listens for suspend, resume, lock, unlock, battery and AC", () => {
    expect([...setup().listeners.keys()].sort()).toEqual(["lock-screen", "on-ac", "on-battery", "resume", "suspend", "unlock-screen"]);
  });

  it("warns on suspend and on lock", () => {
    const { emit, controller } = setup();
    emit("suspend");
    expect(controller.setPowerContext).toHaveBeenLastCalledWith({ asleep: true });
    emit("lock-screen");
    expect(controller.setPowerContext).toHaveBeenLastCalledWith({ locked: true });
  });

  it("clears the sleep warning on resume, re-reads the battery and rescans the printer", () => {
    const { emit, controller, setBattery } = setup(false);
    setBattery(true);
    emit("resume");
    expect(controller.setPowerContext).toHaveBeenLastCalledWith({ asleep: false, onBattery: true });
    expect(controller.refresh).toHaveBeenCalledTimes(1);
  });

  it("clears the lock warning on unlock and rescans", () => {
    const { emit, controller } = setup();
    emit("unlock-screen");
    expect(controller.setPowerContext).toHaveBeenLastCalledWith({ locked: false });
    expect(controller.refresh).toHaveBeenCalledTimes(1);
  });

  it("follows the battery", () => {
    const { emit, controller } = setup();
    emit("on-battery");
    expect(controller.setPowerContext).toHaveBeenLastCalledWith({ onBattery: true });
    emit("on-ac");
    expect(controller.setPowerContext).toHaveBeenLastCalledWith({ onBattery: false });
  });

  it("stops listening on dispose", () => {
    const { dispose, listeners } = setup();
    dispose();
    expect(listeners.size).toBe(0);
  });
});
