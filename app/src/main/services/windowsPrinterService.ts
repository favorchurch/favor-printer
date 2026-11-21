/** Windows Zebra host: the operator installs their approved driver/queue first.
 * We only bind an existing local USB queue with a proven unique hardware serial.
 * A failed probe cannot be interpreted as an empty list or a ready printer. */
import type { PrinterDevice } from "../../shared";
import type { PrinterService } from "./printerService";
import {
  discoverWindowsPrinters,
  WindowsDiscoveryError,
  type WindowsDiscoveryProblem,
  type WindowsDiscoveryReport,
  type WindowsZebraCandidate,
} from "./windowsDiscovery";
import type { CommandRunner } from "./command";

/** Shown while Windows PowerShell refuses to run Favor Printer's bundled helpers. */
export const POWERSHELL_BLOCKED_WARNING =
  "Windows is blocking Favor Printer's printer helper scripts for this account, so printing stays off. " +
  "Reinstall Favor Printer and allow the PowerShell setting, or ask IT.";
export const WINDOWS_SCAN_FAILED_WARNING = "Favor Printer could not check Windows printers. Printing stays off until it can.";

/**
 * What to tell the volunteer when Windows has a Zebra queue that cannot be used, per problem. Checked in this
 * order, so the cable and port come before the serial, and the serial before a rename that alone would not help.
 */
const PROBLEM_NOTICES: [WindowsDiscoveryProblem, (queue: string) => string][] = [
  ["network-queue", (queue) => `The Zebra queue "${queue}" is a network or shared printer. Favor Printer only prints to a Zebra plugged into this PC by USB.`],
  ["not-local", (queue) => `The Zebra queue "${queue}" is a network or shared printer. Favor Printer only prints to a Zebra plugged into this PC by USB.`],
  ["non-usb-port", (queue) => `The Zebra queue "${queue}" does not use a USB port. Plug the Zebra into this PC by USB and use the queue Windows makes for it.`],
  ["hardware-id-unverified", (queue) => `Windows does not show "${queue}" as a Zebra plugged in by USB. Turn the printer on, plug it into this PC by USB, and check it uses the ZDesigner driver.`],
  ["serial-unverified", (queue) => `Windows cannot read the USB serial number of the Zebra on "${queue}". Turn the printer on and plug it straight into this PC by USB. If this keeps happening, ask IT.`],
  ["duplicate-hardware-id", (queue) => `More than one Windows printer queue points at the Zebra on "${queue}". Remove the extra queue in Printers & scanners.`],
  ["duplicate-usb-serial", (queue) => `More than one Windows printer queue reports the serial number of the Zebra on "${queue}". Remove the extra queue in Printers & scanners.`],
  ["duplicate-queue-name", (queue) => `Two Windows printers are named "${queue}". Rename one in Printers & scanners.`],
  ["unsupported-queue-name", (queue) => `Favor Printer cannot print to a queue named "${queue}". In Printers & scanners, rename it so it starts with a letter or number, does not end with a space, and uses only letters, numbers, spaces and _ ( ) . - (up to 127 characters).`],
];

/** Why no Zebra can be offered although Windows has one, from the candidate with the fewest problems. Null when there is no candidate. */
export function windowsUnusableZebraNotice(report: WindowsDiscoveryReport): string | null {
  const closest = [...report.candidates].sort((a, b) => a.problems.length - b.problems.length)[0];
  const match = closest && PROBLEM_NOTICES.find(([problem]) => closest.problems.includes(problem));
  return match ? match[1](closest.queueName) : null;
}

export function eligibleWindowsZebras(report: WindowsDiscoveryReport): WindowsZebraCandidate[] {
  return report.candidates.filter((candidate) => candidate.selectionKey !== null && candidate.verifiedUsbSerial !== null);
}

export function createWindowsPrinterService(deps: {
  run: CommandRunner;
  powershellPath: string;
  probePath: string;
  /** Injected for tests. The app chooses this service only on Windows. */
  platform?: NodeJS.Platform;
}): PrinterService {
  const discover = () => discoverWindowsPrinters({ ...deps, platform: deps.platform ?? process.platform });
  const scan: PrinterService["scan"] = async (selectedId) => {
      let report: WindowsDiscoveryReport;
      try { report = await discover(); }
      catch (error) {
        const failureWarning = error instanceof WindowsDiscoveryError && error.reason === "policy-blocked"
          ? POWERSHELL_BLOCKED_WARNING : WINDOWS_SCAN_FAILED_WARNING;
        return { scan: { kind: "none" }, queue: null, listFailed: true, failureWarning };
      }
      const candidates = eligibleWindowsZebras(report);
      const devices: PrinterDevice[] = candidates.map((candidate) => ({
        id: candidate.selectionKey!,
        // Local selection identity is NOT a cloud UUID; no arbitrary path or network target.
        deviceUri: candidate.selectionKey!,
        usbSerial: candidate.verifiedUsbSerial,
        model: candidate.driverName,
      }));
      if (devices.length === 0) {
        // A Zebra queue that cannot be used is not "plug in a Zebra": say what to change.
        const notice = windowsUnusableZebraNotice(report);
        return { scan: notice ? { kind: "none", notice } : { kind: "none" }, queue: null, listFailed: false };
      }
      // An existing selection never silently transfers to a different Zebra.
      const selected = devices.find((item) => item.id === selectedId) ?? (selectedId === null && devices.length === 1 ? devices[0] : null);
      const candidate = candidates.find((item) => item.selectionKey === selected?.id);
      const queueReady = candidate?.queueState === "available";
      return {
        scan: { kind: "found", devices, selectedId: selected?.id ?? null, queue: queueReady ? "ready" : "disabled" },
        queue: queueReady ? candidate!.queueName : null,
        listFailed: false,
      };
  };
  return {
    scan,
    async setUp(device) {
      // Never install drivers, create queues, or silently rebind devices; avoid
      // reporting setup success for a stale observation after USB removal.
      const fresh = await scan(device.id);
      if (fresh.scan.kind === "found" && fresh.scan.selectedId === device.id && fresh.scan.queue === "ready") {
        return { ok: true, queue: fresh.queue };
      }
      return { ok: false, reason: "failed", queue: null };
    },
  };
}
