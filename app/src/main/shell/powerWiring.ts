/**
 * Feeds Electron's `powerMonitor` into the controller: sleep, lock and battery
 * become warnings, and a wake or unlock re-reads the printer, which may have
 * been unplugged meanwhile.
 */

import type { AppController } from "./controller";

export type PowerMonitorLike = {
  on(event: "suspend" | "resume" | "lock-screen" | "unlock-screen" | "on-battery" | "on-ac", listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  isOnBatteryPower(): boolean;
};

export function wirePowerMonitor(
  monitor: PowerMonitorLike,
  controller: Pick<AppController, "setPowerContext" | "refresh">,
): () => void {
  const refresh = () => void controller.refresh();
  const handlers: [Parameters<PowerMonitorLike["on"]>[0], () => void][] = [
    ["suspend", () => controller.setPowerContext({ asleep: true })],
    [
      "resume",
      () => {
        controller.setPowerContext({ asleep: false, onBattery: monitor.isOnBatteryPower() });
        refresh();
      },
    ],
    ["lock-screen", () => controller.setPowerContext({ locked: true })],
    [
      "unlock-screen",
      () => {
        controller.setPowerContext({ locked: false });
        refresh();
      },
    ],
    ["on-battery", () => controller.setPowerContext({ onBattery: true })],
    ["on-ac", () => controller.setPowerContext({ onBattery: false })],
  ];
  controller.setPowerContext({ onBattery: monitor.isOnBatteryPower() });
  for (const [event, handler] of handlers) monitor.on(event, handler);
  return () => {
    for (const [event, handler] of handlers) monitor.removeListener(event, handler);
  };
}
