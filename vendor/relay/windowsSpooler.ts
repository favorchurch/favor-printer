/**
 * Windows USB Zebra RAW/ZPL transport.
 *
 * The fixed PowerShell helper submits raw bytes through the Windows Print
 * Spooler. A queued job does NOT prove a physical label printed.
 *
 * Byte submission begins only after the relay's persisted sending gate.
 * Uncertainty after that gate is always ambiguous, never automatically retried.
 */
import path from "node:path";
import { RelayAuthError } from "./apiClient";
import { execFileSpawner, type ProcessExit, type Spawner } from "./cups";
import type { PrinterTransport, SendResult } from "./printer";

const MAX_QUEUE_LENGTH = 127;
const SENT_MARKER = "FAVOR_SPOOL_ACCEPTED";
const PROBE_MARKER = "FAVOR_QUEUE_FOUND";
const DEFAULT_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Strictly local queue names; PowerShell always receives these as argv data. */
export function validateWindowsQueueName(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_QUEUE_LENGTH ||
      raw !== raw.trim() || !/^[A-Za-z0-9][A-Za-z0-9 _().-]*$/.test(raw)) {
    throw new Error("Invalid Windows local printer queue name");
  }
  return raw;
}

/** Refuse relative paths, UNC shares and embedded controls. */
export function validateLocalWindowsScriptPath(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) ||
      !path.win32.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Windows spooler helper path must be local and absolute");
  }
  return value;
}

export type WindowsSpoolerOptions = {
  queue: string;
  scriptPath: string;
  platform?: NodeJS.Platform;
  powershellCommand?: string;
  spawner?: Spawner;
  writeTimeoutMs?: number;
  probeTimeoutMs?: number;
};

function failed(exit: ProcessExit): string {
  return "Windows spooler " + (exit.timedOut ? "timed out" : "exit " + String(exit.code ?? "unknown"));
}

function classify(exit: ProcessExit): SendResult {
  if (exit.code === 0 && !exit.timedOut && exit.stdout.trim() === SENT_MARKER) return { kind: "sent" };
  return { kind: "ambiguous", error: failed(exit) };
}

export function createWindowsSpoolerTransport(options: WindowsSpoolerOptions): PrinterTransport {
  const queue = validateWindowsQueueName(options.queue);
  const scriptPath = validateLocalWindowsScriptPath(options.scriptPath);
  const shell = validateLocalWindowsScriptPath(options.powershellCommand ?? DEFAULT_POWERSHELL);
  const spawn = options.spawner ?? execFileSpawner;
  const platform = options.platform ?? process.platform;
  const writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
  const args = (action: "Print" | "Probe") =>
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath, "-Action", action, "-PrinterName", queue];

  return {
    statusUnknown: true,
    async send(_target, zpl, hooks) {
      if (platform !== "win32") return { kind: "unsent", error: "Windows spooler requires Windows" };
      let child;
      try {
        child = spawn(shell, args("Print"));
        await child.started;
      } catch {
        return { kind: "unsent", error: "Windows spooler could not start" };
      }
      let proceed: boolean;
      try {
        proceed = await hooks.beforeWrite();
      } catch (error) {
        child.cancel();
        if (error instanceof RelayAuthError) throw error;
        return { kind: "aborted" };
      }
      if (!proceed) {
        child.cancel();
        return { kind: "aborted" };
      }
      try {
        return classify(await child.finish(Buffer.from(zpl, "utf8"), writeTimeoutMs));
      } catch {
        return { kind: "ambiguous", error: "Windows spooler outcome unknown" };
      }
    },
    async probe() {
      const status = "status_unknown" as const;
      if (platform !== "win32") return { reachable: false, status, error: "Windows spooler requires Windows" };
      try {
        const child = spawn(shell, args("Probe"));
        await child.started;
        const exit = await child.finish(Buffer.alloc(0), probeTimeoutMs);
        return exit.code === 0 && !exit.timedOut && exit.stdout.trim() === PROBE_MARKER
          ? { reachable: true, status }
          : { reachable: false, status, error: failed(exit) };
      } catch {
        return { reachable: false, status, error: "Windows spooler probe unavailable" };
      }
    },
  };
}
