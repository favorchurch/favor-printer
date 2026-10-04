/**
 * D5: the app holds `prevent-app-suspension` exactly while a printer is
 * attached and a job arrived in the last 30 minutes. Detaching the printer
 * releases it at once, and the hold lapses by itself 30 minutes after the last
 * job. The warnings never claim printing works with the lid closed.
 */

import { systemTimers, type Timers } from "./timers";

export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

export type PowerInputs = {
  printerAttached: boolean;
  /** When the last job arrived, ISO string or Date. Null before the first job. */
  lastJobAt: string | Date | null;
};

function toMillis(value: string | Date | null): number | null {
  if (value === null) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

/** Active strictly inside the window: at exactly 30 minutes the hold has ended. */
export function shouldPreventSuspension(inputs: PowerInputs, now: Date): boolean {
  if (!inputs.printerAttached) return false;
  const last = toMillis(inputs.lastJobAt);
  if (last === null) return false;
  return now.getTime() - last < ACTIVE_WINDOW_MS;
}

export function powerWarnings(context: { onBattery: boolean }): string[] {
  const warnings = [
    "Keep the lid open while printing. Closing the lid can stop labels from printing.",
  ];
  if (context.onBattery) warnings.push("This Mac is on battery. Plug it in for long events.");
  return warnings;
}

/** The slice of Electron's `powerSaveBlocker` the controller uses. */
export type PowerSaveBlocker = {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
};

export type PowerController = {
  /** Re-evaluates and returns whether suspension is being prevented. */
  update(inputs: PowerInputs): boolean;
  dispose(): void;
};

export function createPowerController(deps: {
  blocker: PowerSaveBlocker;
  now?: () => Date;
  timers?: Timers;
}): PowerController {
  const { blocker } = deps;
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? systemTimers;

  let blockerId: number | null = null;
  let expiry: unknown = null;

  const clearExpiry = () => {
    if (expiry !== null) timers.clearTimeout(expiry);
    expiry = null;
  };

  const release = () => {
    clearExpiry();
    if (blockerId === null) return;
    blocker.stop(blockerId);
    blockerId = null;
  };

  const update = (inputs: PowerInputs): boolean => {
    clearExpiry();
    const current = now();
    if (!shouldPreventSuspension(inputs, current)) {
      release();
      return false;
    }
    if (blockerId === null) blockerId = blocker.start("prevent-app-suspension");
    // Nothing else will wake the app when the window closes, so ask for that.
    const last = toMillis(inputs.lastJobAt) ?? current.getTime();
    const remaining = Math.max(0, last + ACTIVE_WINDOW_MS - current.getTime());
    expiry = timers.setTimeout(() => {
      expiry = null;
      update(inputs);
    }, remaining);
    return true;
  };

  return { update, dispose: release };
}
