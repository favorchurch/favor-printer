/**
 * Read-only Windows discovery boundary. This consumes the versioned CIM probe;
 * it does not install a driver, enroll a relay, create a queue, or print.
 * A Windows PnP instance is a local selection key, never the cloud printer UUID.
 */

import path from "node:path";

import { validateWindowsQueueName } from "../../../../vendor/relay/windowsSpooler";
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
  | "duplicate-usb-serial"
  | "unsupported-queue-name";

/**
 * unique-usb-parent: walked from the queue's own PNPDeviceID (a USBPRINT device on the queue's port).
 * usbprint-port: PNPDeviceID was empty (the ZDesigner driver), so the probe took the one present USBPRINT
 * device on the queue's port. Both still need a present Zebra USB parent with CM_DEVCAP_UNIQUEID.
 */
export type WindowsSerialEvidence = "unique-usb-parent" | "usbprint-port";

export type WindowsQueueState = "available" | "offline" | "attention" | "unknown";

export type WindowsZebraCandidate = {
  queueName: string;
  driverName: string;
  portName: string;
  /** Original Windows value for local comparison; no serial number is inferred. */
  pnpDeviceId: string | null;
  /** Hardware serial from a present Zebra USB parent with CM_DEVCAP_UNIQUEID; never inferred from queue/PnP IDs. */
  verifiedUsbSerial: string | null;
  /** How the probe reached that serial, for logs. Null whenever verifiedUsbSerial is null. */
  serialEvidence: WindowsSerialEvidence | null;
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
  /** The USBPRINT device the probe tied to this queue's port, or null. */
  usbPrintInstanceId: string | null;
  verifiedUsbSerial: string | null;
  serialEvidence: WindowsSerialEvidence | null;
  isLocal: boolean;
  isNetwork: boolean;
  workOffline: boolean;
  printerStatus: number | null;
  detectedErrorState: number | null;
  /** Win32_Printer.PrinterState (PRINTER_STATUS_* bitmask). Optional in schemaVersion 1: null when absent. */
  printerState: number | null;
  /** Win32_Printer.ExtendedDetectedErrorState. Optional in schemaVersion 1: null when absent. */
  extendedDetectedErrorState: number | null;
};

export class WindowsDiscoveryError extends Error {
  constructor(public readonly reason: "unsupported-platform" | "invalid-path" | "probe-failed" | "probe-timeout" | "invalid-probe" | "policy-blocked") {
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

function bitmaskField(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new WindowsDiscoveryError("invalid-probe");
  return value;
}

function readPrinter(value: unknown): ProbePrinter {
  const row = object(value);
  return {
    queueName: textField(row.queueName, 256)!,
    driverName: textField(row.driverName, 256)!,
    portName: textField(row.portName, 256)!,
    pnpDeviceId: textField(row.pnpDeviceId, 512, true),
    usbPrintInstanceId: row.usbPrintInstanceId === undefined ? null : textField(row.usbPrintInstanceId, 512, true),
    verifiedUsbSerial: row.verifiedUsbSerial === undefined ? null : textField(row.verifiedUsbSerial, 64, true),
    serialEvidence: row.serialEvidence === "unique-usb-parent" || row.serialEvidence === "usbprint-port" ? row.serialEvidence : null,
    isLocal: booleanField(row.isLocal),
    isNetwork: booleanField(row.isNetwork),
    workOffline: booleanField(row.workOffline),
    printerStatus: statusField(row.printerStatus),
    detectedErrorState: statusField(row.detectedErrorState),
    printerState: row.printerState === undefined ? null : bitmaskField(row.printerState),
    extendedDetectedErrorState: row.extendedDetectedErrorState === undefined ? null : statusField(row.extendedDetectedErrorState),
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

/**
 * Review F1, checked again here after the probe: the USBPRINT device a serial came from must sit on this queue's
 * own port. Windows names it USBPRINT\<model>\<n>&...&<port>, so its ID must end in "&" + PortName ("&" keeps
 * USB002 from matching ...&USB001). A different printer reusing the port after a replug is caught by the unique
 * USB serial and the app's paired-serial check, not by this rule.
 */
export function usbPrintInstanceOnPort(instanceId: string | null, portName: string): boolean {
  const id = windowsZebraInstanceId(instanceId);
  return id !== null && id.startsWith("USBPRINT\\") && /^USB\d{3,}$/i.test(portName) && id.endsWith(`&${portName.toUpperCase()}`);
}

/** The serial only when the probe's evidence and the port binding agree; anything else is unverified. */
function provenSerial(row: ProbePrinter): string | null {
  if (!isUsableUsbSerial(row.verifiedUsbSerial) || !usbPrintInstanceOnPort(row.usbPrintInstanceId, row.portName)) return null;
  const sameAsPnp = row.pnpDeviceId !== null && row.pnpDeviceId.toUpperCase() === row.usbPrintInstanceId!.toUpperCase();
  if (row.serialEvidence === "unique-usb-parent" && sameAsPnp) return row.verifiedUsbSerial;
  if (row.serialEvidence === "usbprint-port" && row.pnpDeviceId === null) return row.verifiedUsbSerial;
  return null;
}

/** The queue's hardware instance: its PNPDeviceID, or when Windows left that empty, the probe's port-bound USBPRINT device. */
function instanceIdOf(row: ProbePrinter): string | null {
  return row.pnpDeviceId === null ? windowsZebraInstanceId(row.usbPrintInstanceId) : windowsZebraInstanceId(row.pnpDeviceId);
}

/*
 * Win32_Printer.PrinterState carries the spooler's PRINTER_STATUS_* bits (winspool.h). The ZDesigner driver reports
 * DetectedErrorState 0, which means the driver reports no status, so these bits are what can still show a paused
 * queue or a printer the spooler cannot reach. Not yet captured on a real ZD421 with paper out, head open, paused,
 * or unplugged: the mapping follows the documented bit names.
 */
// PRINTER_STATUS_OFFLINE 0x80, NOT_AVAILABLE 0x1000, SERVER_UNKNOWN 0x800000, SERVER_OFFLINE 0x2000000.
const PRINTER_STATE_OFFLINE = 0x80 | 0x1000 | 0x80_0000 | 0x200_0000;
// PRINTER_STATUS_PAUSED 0x1, ERROR 0x2, PENDING_DELETION 0x4, PAPER_JAM 0x8, PAPER_OUT 0x10, MANUAL_FEED 0x20,
// PAPER_PROBLEM 0x40, OUTPUT_BIN_FULL 0x800, NO_TONER 0x40000, PAGE_PUNT 0x80000, USER_INTERVENTION 0x100000,
// OUT_OF_MEMORY 0x200000, DOOR_OPEN 0x400000, DRIVER_UPDATE_NEEDED 0x4000000.
const PRINTER_STATE_ATTENTION =
  0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x800 | 0x4_0000 | 0x8_0000 | 0x10_0000 | 0x20_0000 | 0x40_0000 | 0x400_0000;
// Not blocking: IO_ACTIVE 0x100, BUSY 0x200, PRINTING 0x400, WAITING 0x2000, PROCESSING 0x4000, INITIALIZING 0x8000,
// WARMING_UP 0x10000, TONER_LOW 0x20000, POWER_SAVE 0x1000000.
const PRINTER_STATE_BENIGN = 0x100 | 0x200 | 0x400 | 0x2000 | 0x4000 | 0x8000 | 0x1_0000 | 0x2_0000 | 0x100_0000;
const PRINTER_STATE_KNOWN = PRINTER_STATE_OFFLINE | PRINTER_STATE_ATTENTION | PRINTER_STATE_BENIGN;
// CIM ExtendedDetectedErrorState values that do not block printing: 0 Unknown, 2 No Error, 3 Low Paper, 5 Low Toner.
const EXTENDED_ERROR_NOT_BLOCKING: readonly number[] = [0, 2, 3, 5];

/** Bitwise AND on a full uint32 (JavaScript's & works on signed 32-bit values). */
function hasBits(value: number, mask: number): boolean {
  return (BigInt(value) & BigInt(mask >>> 0)) !== 0n;
}

function queueState(row: ProbePrinter): WindowsQueueState {
  const state = row.printerState;
  if (row.workOffline || row.printerStatus === 7 || row.detectedErrorState === 9) return "offline";
  if (state !== null && hasBits(state, PRINTER_STATE_OFFLINE)) return "offline";
  if (row.printerStatus === 6 || (row.detectedErrorState !== null && row.detectedErrorState >= 3 && row.detectedErrorState <= 11)) return "attention";
  if (state !== null && hasBits(state, PRINTER_STATE_ATTENTION)) return "attention";
  // Fail safe: ExtendedDetectedErrorState 0 (Unknown, the idle ZD421's value) and 2 (No Error) are clear, and
  // 3 (Low Paper) and 5 (Low Toner) are warnings that still print. Any other value needs a look.
  if (row.extendedDetectedErrorState !== null && !EXTENDED_ERROR_NOT_BLOCKING.includes(row.extendedDetectedErrorState)) return "attention";
  // A bit this code does not name (0xF8000000) is not evidence of a ready queue.
  if (state !== null && hasBits(state, ~PRINTER_STATE_KNOWN)) return "unknown";
  // Win32_Printer: Idle/Printing/Warmup with DetectedErrorState No Error (2) or Unknown (0). A real ZD421 on the
  // ZDesigner driver, idle and ready, reports PrinterStatus 3, DetectedErrorState 0, WorkOffline false (2026-11-20);
  // so do the PC's other local queues. With this driver 0 means the driver reports no status, so it holds whenever
  // the printer is attached; the PrinterState and ExtendedDetectedErrorState checks above are what can still turn a
  // paused or offline queue away. Any other error state (4 No Paper, 7 Door Open, 8 Jammed, 9 Offline, ...) was
  // handled above or stays unknown, and so do missing (null) or new values. Not proof the hardware is attached.
  if ([3, 4, 5].includes(row.printerStatus ?? -1) && (row.detectedErrorState === 2 || row.detectedErrorState === 0)) return "available";
  return "unknown";
}

function namesAQueue(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const name = (value as Record<string, unknown>).queueName;
  return typeof name === "string" && name.length > 0;
}

/**
 * Loose on purpose: used only to decide that an unreadable row must not be ignored. Any serial evidence counts
 * too: a skipped row is left out of the duplicate counts, so a second queue for the same printer must not vanish.
 */
function couldBeZebra(row: Record<string, unknown>): boolean {
  if ([row.verifiedUsbSerial, row.serialEvidence, row.usbPrintInstanceId].some((value) => value !== undefined && value !== null && value !== "")) return true;
  return [row.queueName, row.driverName, row.pnpDeviceId, row.usbPrintInstanceId].some(
    (value) => typeof value === "string" && /zebra|zdesigner|ztc|VID_0A5F/i.test(value),
  );
}

function isPrintableQueueName(name: string): boolean {
  try {
    validateWindowsQueueName(name);
    return true;
  } catch {
    return false;
  }
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
  const rows: ProbePrinter[] = [];
  for (const raw of payload.printers) {
    try {
      rows.push(readPrinter(raw));
    } catch (error) {
      // One unrelated queue with an unusable field (an empty port, a null flag) must not turn printing off for
      // a Zebra on the same PC. A row that could be a Zebra, or that does not even name a queue, still fails closed.
      if (!(error instanceof WindowsDiscoveryError) || !namesAQueue(raw) || couldBeZebra(raw)) throw error;
    }
  }
  const queueNames = counts(rows.map((row) => row.queueName.toUpperCase()));
  const instanceIds = counts(rows.map(instanceIdOf).filter((id): id is string => id !== null));
  const serials = counts(rows.map(provenSerial).filter((serial): serial is string => serial !== null).map((serial) => serial.toUpperCase()));
  const candidates: WindowsZebraCandidate[] = [];
  for (const row of rows) {
    const instanceId = instanceIdOf(row);
    // A suggestive label/driver is a candidate only, never sufficient for identity.
    if (!instanceId && !/\b(?:zebra|zdesigner|ztc)\b/i.test(`${row.queueName} ${row.driverName}`)) continue;
    const problems: WindowsDiscoveryProblem[] = [];
    if (row.isNetwork) problems.push("network-queue");
    if (!row.isLocal) problems.push("not-local");
    if (!/^USB\d{3,}$/i.test(row.portName)) problems.push("non-usb-port");
    if (!instanceId) problems.push("hardware-id-unverified");
    const serial = provenSerial(row);
    if (!serial) problems.push("serial-unverified");
    if (serial && (serials.get(serial.toUpperCase()) ?? 0) > 1) problems.push("duplicate-usb-serial");
    if ((queueNames.get(row.queueName.toUpperCase()) ?? 0) > 1) problems.push("duplicate-queue-name");
    // Printing only accepts names it can hand to the spooler helper as plain argv data. A queue it would refuse
    // must not be offered, or the one-time pairing code is spent on a printer that can never print.
    if (!isPrintableQueueName(row.queueName)) problems.push("unsupported-queue-name");
    if (instanceId && (instanceIds.get(instanceId) ?? 0) > 1) problems.push("duplicate-hardware-id");
    candidates.push({
      queueName: row.queueName,
      driverName: row.driverName,
      portName: row.portName,
      pnpDeviceId: row.pnpDeviceId,
      verifiedUsbSerial: serial,
      serialEvidence: serial === null ? null : row.serialEvidence,
      selectionKey: problems.length === 0 ? `windows-pnp:${instanceId}` : null,
      queueState: queueState(row),
      problems,
    });
  }
  return { inspectedQueues: payload.printers.length, candidates };
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
  // powershell.exe refused to load the script (execution policy). The error id
  // is not localized; the message is. Nothing ran, so this says nothing about printers.
  if (result.code === 1 && /FullyQualifiedErrorId\s*:\s*UnauthorizedAccess\s*$/m.test(result.stderr)) {
    throw new WindowsDiscoveryError("policy-blocked");
  }
  if (result.code !== 0) throw new WindowsDiscoveryError("probe-failed");
  return parseWindowsPrinterProbe(result.stdout);
}
