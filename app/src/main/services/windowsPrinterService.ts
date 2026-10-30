/** Windows Zebra host: the operator installs their approved driver/queue first.
 * We only bind an existing local USB queue with a proven unique hardware serial.
 * A failed probe cannot be interpreted as an empty list or a ready printer. */
import type { PrinterDevice } from "../../shared";
import type { PrinterService } from "./printerService";
import { discoverWindowsPrinters, WindowsDiscoveryError, type WindowsDiscoveryReport, type WindowsZebraCandidate } from "./windowsDiscovery";
import type { CommandRunner } from "./command";

/** Shown while Windows PowerShell refuses to run Favor Printer's bundled helpers. */
export const POWERSHELL_BLOCKED_WARNING =
  "Windows is blocking Favor Printer's printer helper scripts for this account, so printing stays off. " +
  "Reinstall Favor Printer and allow the PowerShell setting, or ask IT.";
export const WINDOWS_SCAN_FAILED_WARNING = "Favor Printer could not check Windows printers. Printing stays off until it can.";

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
      if (devices.length === 0) return { scan: { kind: "none" }, queue: null, listFailed: false };
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
