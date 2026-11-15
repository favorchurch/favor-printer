/**
 * Sets up the Zebra itself: print mode, media calibration, then saving both to
 * the printer's memory. Each step is one `lp -o raw` job to the queue the
 * printer service resolved, run through the command runner (no shell).
 */

import type { PrinterSetupResult, PrinterSetupStep } from "../../shared";
import { BINARIES, type CommandRunner } from "./command";

/** Sets the print mode. */
export const MODE_PAYLOAD = "^XA^MMC^XZ\n";
/** Measures the label stock. */
export const CALIBRATE_PAYLOAD = "~JC\n";
/** Writes the current settings to the printer's flash so they survive a power cycle. */
export const SAVE_PAYLOAD = "^XA^JUS^XZ\n";

/**
 * Mode first, calibrate, then save. Order matters: calibration measures the stock under the mode
 * that is already set, and saving stores what calibration found. Each payload is its own job so CUPS
 * keeps them in order and `~JC`, an immediate command the printer acts on as it arrives, cannot jump
 * ahead of `^MMC` the way it could inside one stream.
 */
export const SETUP_STEPS: readonly { step: PrinterSetupStep; payload: string }[] = [
  { step: "mode", payload: MODE_PAYLOAD },
  { step: "calibrate", payload: CALIBRATE_PAYLOAD },
  { step: "save", payload: SAVE_PAYLOAD },
];

export type PrinterSetup = {
  /** `no-queue` and `busy` spawn nothing. A failure stops at that step and names it. */
  run(queue: string | null): Promise<PrinterSetupResult>;
};

export function createPrinterSetup(deps: { run: CommandRunner }): PrinterSetup {
  let running = false;
  return {
    async run(queue) {
      if (!queue) return { ok: false, reason: "no-queue" };
      if (running) return { ok: false, reason: "busy" };
      running = true;
      try {
        for (const { step, payload } of SETUP_STEPS) {
          const result = await deps.run(BINARIES.lp, ["-d", queue, "-o", "raw"], { input: payload });
          if (result.code !== 0) return { ok: false, reason: "failed", step };
        }
        return { ok: true };
      } finally {
        running = false;
      }
    },
  };
}
