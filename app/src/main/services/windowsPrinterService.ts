/** Windows Zebra host: the operator installs their approved driver/queue first.
 * We only bind an existing local USB queue with a proven unique hardware serial.
 * A failed probe cannot be interpreted as an empty list or a ready printer. */
import type { PrinterDevice } from "../../shared";
import type { PrinterService } from "./printerService";
import { discoverWindowsPrinters, type WindowsDiscoveryReport, type WindowsZebraCandidate } from "./windowsDiscovery";
import type { CommandRunner } from "./command";

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
      catch { return { scan: { kind: "none" }, queue: null, listFailed: true }; }
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
