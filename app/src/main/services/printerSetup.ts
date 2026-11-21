/**
 * Sets up the Zebra itself: print mode, media calibration, then saving both to
 * the printer's memory. Each step is one raw job (`lp -o raw` on macOS, a RAW
 * spool job on Windows) to the queue the printer service resolved, run through
 * the command runner (no shell).
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

/** Sends one payload as one raw job. `true` only when the job was accepted. */
type SendRaw = (queue: string, payload: string) => Promise<boolean>;

function createSetupSequence(send: SendRaw): PrinterSetup {
  let running = false;
  return {
    async run(queue) {
      if (!queue) return { ok: false, reason: "no-queue" };
      if (running) return { ok: false, reason: "busy" };
      running = true;
      try {
        for (const { step, payload } of SETUP_STEPS) {
          if (!(await send(queue, payload))) return { ok: false, reason: "failed", step };
        }
        return { ok: true };
      } finally {
        running = false;
      }
    },
  };
}

export function createPrinterSetup(deps: { run: CommandRunner }): PrinterSetup {
  return createSetupSequence(async (queue, payload) => (await deps.run(BINARIES.lp, ["-d", queue, "-o", "raw"], { input: payload })).code === 0);
}

/**
 * Windows: each step is one RAW spool job through the bundled `print-raw.ps1`, the same helper and
 * argument shape the relay prints labels with. Exit 0 (`FAVOR_SPOOL_ACCEPTED`) is the only success;
 * an execution-policy refusal or any spooler error stops the sequence at that step.
 */
export function createWindowsPrinterSetup(deps: { run: CommandRunner; powershellPath: string; printPath: string }): PrinterSetup {
  return createSetupSequence(async (queue, payload) => {
    const result = await deps.run(
      deps.powershellPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", deps.printPath, "-Action", "Print", "-PrinterName", queue],
      { input: payload, timeoutMs: 30_000 },
    );
    return result.code === 0 && result.stdout.includes("FAVOR_SPOOL_ACCEPTED");
  });
}
