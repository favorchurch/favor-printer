/**
 * Read-only Windows discovery boundary. This consumes the versioned CIM probe;
 * it does not install a driver, enroll a relay, create a queue, or print.
 * A Windows PnP instance is a local selection key, never the cloud printer UUID.
 */

import path from "node:path";

import { isUsableUsbSerial } from "../../shared";
import type { CommandRunner } from "./command";

export type WindowsDiscoveryProblem =
  | "network-queue"
  | "not-local"
  | "non-usb-port"
  | "hardware-id-unverified"
  | "duplicate-queue-name"
  | "duplicate-hardware-id"
  | "serial-unverified"
  | "duplicate-usb-serial";

export type WindowsQueueState = "available" | "offline" | "attention" | "unknown";

export type WindowsZebraCandidate = {
  queueName: string;
  driverName: string;
  portName: string;
  /** Original Windows value for local comparison; no serial number is inferred. */
  pnpDeviceId: string | null;
  /** Hardware serial from a present Zebra USB parent with CM_DEVCAP_UNIQUEID; never inferred from queue/PnP IDs. */
  verifiedUsbSerial: string | null;
  /** Null unless this probe identifies one unambiguous local USB instance. */
  selectionKey: string | null;
  /** Spooler observation only: even `available` is not proof of attached hardware. */
  queueState: WindowsQueueState;
  problems: WindowsDiscoveryProblem[];
};

export type WindowsDiscoveryReport = {
  inspectedQueues: number;
  candidates: WindowsZebraCandidate[];
};

type ProbePrinter = {
  queueName: string;
  driverName: string;
  portName: string;
  pnpDeviceId: string | null;
  verifiedUsbSerial: string | null;
  serialEvidence: "unique-usb-parent" | null;
  isLocal: boolean;
  isNetwork: boolean;
  workOffline: boolean;
  printerStatus: number | null;
  detectedErrorState: number | null;
};

export class WindowsDiscoveryError extends Error {
  constructor(public readonly reason: "unsupported-platform" | "invalid-path" | "probe-failed" | "probe-timeout" | "invalid-probe") {
    super(`Windows printer discovery: ${reason}`);
    this.name = "WindowsDiscoveryError";
  }
}

const MAX_PROBE_BYTES = 256 * 1024;
const MAX_QUEUES = 256;
function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WindowsDiscoveryError("invalid-probe");
  return value as Record<string, unknown>;
}

function textField(value: unknown, maxLength: number, optional = false): string | null {
  if (optional && (value === null || value === "")) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value || hasControlCharacters(value)) {
    throw new WindowsDiscoveryError("invalid-probe");
  }
  return value;
}

function booleanField(value: unknown): boolean {
  if (typeof value !== "boolean") throw new WindowsDiscoveryError("invalid-probe");
  return value;
}

function statusField(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) throw new WindowsDiscoveryError("invalid-probe");
  return value;
}

function readPrinter(value: unknown): ProbePrinter {
  const row = object(value);
  return {
    queueName: textField(row.queueName, 256)!,
    driverName: textField(row.driverName, 256)!,
    portName: textField(row.portName, 256)!,
    pnpDeviceId: textField(row.pnpDeviceId, 512, true),
    verifiedUsbSerial: row.verifiedUsbSerial === undefined ? null : textField(row.verifiedUsbSerial, 64, true),
    serialEvidence: row.serialEvidence === "unique-usb-parent" ? "unique-usb-parent" : null,
    isLocal: booleanField(row.isLocal),
    isNetwork: booleanField(row.isNetwork),
    workOffline: booleanField(row.workOffline),
    printerStatus: statusField(row.printerStatus),
    detectedErrorState: statusField(row.detectedErrorState),
  };
}

/** Strictly recognized Zebra USB PnP forms; SWD/PRINTENUM and queue names are not hardware identity. */
export function windowsZebraInstanceId(value: string | null): string | null {
  if (value === null || value.length > 512 || /[^\x21-\x7e]/.test(value)) return null;
  const id = value.toUpperCase();
  if (/^USB\\VID_0A5F&PID_[0-9A-F]{4}(?:&MI_[0-9A-F]{2})?\\[A-Z0-9_&.+-]+$/.test(id)) return id;
  if (/^USBPRINT\\(?:ZEBRA|ZTC)[A-Z0-9_&.+-]*\\[A-Z0-9_&.+-]+$/.test(id)) return id;
  return null;
}

function queueState(row: ProbePrinter): WindowsQueueState {
  if (row.workOffline || row.printerStatus === 7 || row.detectedErrorState === 9) return "offline";
  if (row.printerStatus === 6 || (row.detectedErrorState !== null && row.detectedErrorState >= 3 && row.detectedErrorState <= 11)) return "attention";
  // Win32_Printer: Idle/Printing/Warmup and No Error. Missing or new values stay unknown.
  if ([3, 4, 5].includes(row.printerStatus ?? -1) && row.detectedErrorState === 2) return "available";
  return "unknown";
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

/** Malformed/partial probe data fails closed; an empty successful inventory is distinct from failure. */
export function parseWindowsPrinterProbe(stdout: string): WindowsDiscoveryReport {
  if (Buffer.byteLength(stdout, "utf8") > MAX_PROBE_BYTES) throw new WindowsDiscoveryError("invalid-probe");
  let payload: Record<string, unknown>;
  try {
    // Windows PowerShell can emit a UTF-8 BOM when redirected to a file.
    payload = object(JSON.parse(stdout.replace(/^\uFEFF/, "")));
  } catch {
    throw new WindowsDiscoveryError("invalid-probe");
  }
  if (payload.schemaVersion !== 1 || payload.source !== "Win32_Printer" || !Array.isArray(payload.printers) || payload.printers.length > MAX_QUEUES) {
    throw new WindowsDiscoveryError("invalid-probe");
  }
  const rows = payload.printers.map(readPrinter);
  const queueNames = counts(rows.map((row) => row.queueName.toUpperCase()));
  const instanceIds = counts(rows.map((row) => windowsZebraInstanceId(row.pnpDeviceId)).filter((id): id is string => id !== null));
  const serials = counts(rows.filter((row) => row.serialEvidence === "unique-usb-parent" && isUsableUsbSerial(row.verifiedUsbSerial)).map((row) => row.verifiedUsbSerial!.toUpperCase()));
  const candidates: WindowsZebraCandidate[] = [];
  for (const row of rows) {
    const instanceId = windowsZebraInstanceId(row.pnpDeviceId);
    // A suggestive label/driver is a candidate only, never sufficient for identity.
    if (!instanceId && !/\b(?:zebra|zdesigner|ztc)\b/i.test(`${row.queueName} ${row.driverName}`)) continue;
    const problems: WindowsDiscoveryProblem[] = [];
    if (row.isNetwork) problems.push("network-queue");
    if (!row.isLocal) problems.push("not-local");
    if (!/^USB\d{3,}$/i.test(row.portName)) problems.push("non-usb-port");
    if (!instanceId) problems.push("hardware-id-unverified");
    const serial = row.serialEvidence === "unique-usb-parent" && isUsableUsbSerial(row.verifiedUsbSerial) ? row.verifiedUsbSerial : null;
    if (!serial) problems.push("serial-unverified");
    if (serial && (serials.get(serial.toUpperCase()) ?? 0) > 1) problems.push("duplicate-usb-serial");
    if ((queueNames.get(row.queueName.toUpperCase()) ?? 0) > 1) problems.push("duplicate-queue-name");
    if (instanceId && (instanceIds.get(instanceId) ?? 0) > 1) problems.push("duplicate-hardware-id");
    candidates.push({
      queueName: row.queueName,
      driverName: row.driverName,
      portName: row.portName,
      pnpDeviceId: row.pnpDeviceId,
      verifiedUsbSerial: serial,
      selectionKey: problems.length === 0 ? `windows-pnp:${instanceId}` : null,
      queueState: queueState(row),
      problems,
    });
  }
  return { inspectedQueues: rows.length, candidates };
}

/** Uses the existing execFile boundary. The fixed probe gets no queue names or interpolated commands. */
export async function discoverWindowsPrinters(deps: {
  platform: NodeJS.Platform;
  run: CommandRunner;
  powershellPath: string;
  probePath: string;
}): Promise<WindowsDiscoveryReport> {
  if (deps.platform !== "win32") throw new WindowsDiscoveryError("unsupported-platform");
  if ([deps.powershellPath, deps.probePath].some((file) => !/^[A-Za-z]:\\/.test(file) || !path.win32.isAbsolute(file) || hasControlCharacters(file))) {
    throw new WindowsDiscoveryError("invalid-path");
  }
  const result = await deps.run(deps.powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", deps.probePath], { timeoutMs: 15_000 });
  if (result.timedOut) throw new WindowsDiscoveryError("probe-timeout");
  if (result.code !== 0) throw new WindowsDiscoveryError("probe-failed");
  return parseWindowsPrinterProbe(result.stdout);
}
