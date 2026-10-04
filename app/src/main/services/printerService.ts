/**
 * Finds the Zebra on USB and makes sure a CUPS queue points at it.
 * Startup never depends on this: scanning only reads, and `setUp` runs only
 * when the volunteer asks for it.
 */

import type { PrinterDevice, PrinterScan, SetUpPrinterResult } from "../../shared";
import { BINARIES, type CommandResult, type CommandRunner } from "./command";
import { parseLpinfo } from "./lpinfo";
import { findQueue, parseLpstatDevices, parseLpstatPrinters, queueNameFor, type QueueLookup } from "./queue";

/** CUPS's bundled Zebra ZPL driver. A raw queue is refused on macOS. */
export const ZEBRA_PPD = "drv:///sample.drv/zebra.ppd";

const LPINFO_TIMEOUT_MS = 30_000;

/** `lpstat` could not be read, so the state of the queues is unknown. */
export class QueueLookupError extends Error {
  constructor(detail: string) {
    super(`Could not read the CUPS queues: ${detail}`);
    this.name = "QueueLookupError";
  }
}

/** The text `lpstat` prints, with its exit code checked. With no queues at all it exits 1 and says so; that is an empty list. */
function lpstatOutput(result: CommandResult): string {
  if (result.code === 0) return result.stdout;
  if (result.code !== null && !result.timedOut && /no destinations added/i.test(`${result.stderr}\n${result.stdout}`)) {
    return "";
  }
  throw new QueueLookupError(result.timedOut ? "lpstat timed out" : `lpstat exited ${result.code ?? "without a code"}`);
}

export type ScanOutcome = {
  scan: PrinterScan;
  /** The queue bound to the selected printer, when there is one. */
  queue: string | null;
  /** `lpinfo` or `lpstat` failed, so the result may mean "could not look". The queue is then never "ready". */
  listFailed: boolean;
};

export type SetUpOutcome = SetUpPrinterResult & { queue: string | null };

export type PrinterService = {
  scan(selectedId: string | null): Promise<ScanOutcome>;
  setUp(device: PrinterDevice): Promise<SetUpOutcome>;
};

const PERMISSION_FAILURE = /not authorized|unauthorized|forbidden|permission denied|operation not permitted|not allowed/i;

/** macOS asks an admin before it changes printers. A refusal means: guide the volunteer to System Settings. */
export function classifyLpadminFailure(result: CommandResult): "permission" | "failed" {
  if (result.code === null || result.timedOut) return "failed";
  return PERMISSION_FAILURE.test(`${result.stderr}\n${result.stdout}`) ? "permission" : "failed";
}

export function createPrinterService(deps: { run: CommandRunner }): PrinterService {
  const { run } = deps;

  /** Throws QueueLookupError when `lpstat` fails. */
  async function lookupQueue(device: PrinterDevice): Promise<QueueLookup> {
    const [devices, printers] = await Promise.all([
      run(BINARIES.lpstat, ["-v"]),
      run(BINARIES.lpstat, ["-p"]),
    ]);
    return findQueue(device, parseLpstatDevices(lpstatOutput(devices)), parseLpstatPrinters(lpstatOutput(printers)));
  }

  return {
    async scan(selectedId) {
      const listing = await run(BINARIES.lpinfo, ["-v"], { timeoutMs: LPINFO_TIMEOUT_MS });
      if (listing.code !== 0) return { scan: { kind: "none" }, queue: null, listFailed: true };

      const devices = parseLpinfo(listing.stdout);
      if (devices.length === 0) return { scan: { kind: "none" }, queue: null, listFailed: false };

      const selected =
        devices.find((device) => device.id === selectedId) ?? (devices.length === 1 ? devices[0] : null);
      if (!selected) {
        return {
          scan: { kind: "found", devices, selectedId: null, queue: "missing" },
          queue: null,
          listFailed: false,
        };
      }
      try {
        const found = await lookupQueue(selected);
        return {
          scan: { kind: "found", devices, selectedId: selected.id, queue: found.state },
          queue: found.queue,
          listFailed: false,
        };
      } catch (error) {
        if (!(error instanceof QueueLookupError)) throw error;
        // Unknown is unavailable: the printer is seen, but its queue is never reported ready.
        return {
          scan: { kind: "found", devices, selectedId: selected.id, queue: "disabled" },
          queue: null,
          listFailed: true,
        };
      }
    },

    async setUp(device) {
      let existing: QueueLookup;
      try {
        existing = await lookupQueue(device);
      } catch (error) {
        if (!(error instanceof QueueLookupError)) throw error;
        // Without knowing what exists, creating a queue could duplicate one.
        return { ok: false, reason: "failed", queue: null };
      }
      if (existing.state === "ready") return { ok: true, queue: existing.queue };

      // A disabled queue for this device is switched back on. Anything else gets a new queue.
      const queue = existing.queue ?? queueNameFor(device);
      const args =
        existing.state === "disabled"
          ? ["-p", queue, "-E"]
          : ["-p", queue, "-E", "-v", device.deviceUri, "-m", ZEBRA_PPD];
      const result = await run(BINARIES.lpadmin, args);
      if (result.code === 0) return { ok: true, queue };
      return { ok: false, reason: classifyLpadminFailure(result), queue: null };
    },
  };
}
