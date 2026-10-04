/**
 * CUPS queue naming and lookup. A queue is "ours" when its device URI points at
 * the selected Zebra, whatever the queue is called, so a queue made by hand or by
 * an earlier install is reused instead of duplicated.
 */

import { validateCupsQueue } from "../../../../vendor/relay/cups";
import type { PrinterDevice, QueueState } from "../../shared";
import { parseUsbUri } from "./lpinfo";

export type QueueDevice = { queue: string; deviceUri: string };

export type QueueLookup = { state: QueueState; queue: string | null };

/** Same rule the relay enforces, so a name accepted here is one the relay accepts. */
export function isValidQueueName(name: string): boolean {
  try {
    validateCupsQueue(name);
    return true;
  } catch {
    return false;
  }
}

/** Throws when the name could be read as anything but a queue. */
export function assertQueueName(name: string): string {
  return validateCupsQueue(name);
}

const FALLBACK_QUEUE_NAME = "Favor_Zebra";

/** `Favor_<serial or model>`, reduced to the characters a queue name allows. */
export function queueNameFor(device: PrinterDevice): string {
  const label = (device.usbSerial ?? device.model).replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[_.-]+|[_.-]+$/g, "");
  const name = label ? `Favor_${label}` : FALLBACK_QUEUE_NAME;
  return validateCupsQueue(name.slice(0, 127));
}

/** `lpstat -v`: `device for <queue>: <uri>`. */
export function parseLpstatDevices(stdout: string): QueueDevice[] {
  const devices: QueueDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^device for (\S+): (\S.*?)\s*$/.exec(line);
    if (match) devices.push({ queue: match[1], deviceUri: match[2] });
  }
  return devices;
}

/**
 * `lpstat -p`: `printer <queue> is idle.  enabled since ...` or
 * `printer <queue> disabled since ...`. Returns queue -> enabled.
 */
export function parseLpstatPrinters(stdout: string): Map<string, boolean> {
  const queues = new Map<string, boolean>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^printer (\S+) (.*)$/.exec(line);
    if (match) queues.set(match[1], !/\bdisabled\b/.test(match[2]));
  }
  return queues;
}

/** True when two device URIs name the same physical printer. */
export function isSameDevice(a: string, b: string): boolean {
  if (a === b) return true;
  const left = parseUsbUri(a);
  const right = parseUsbUri(b);
  if (!left || !right) return false;
  if (left.serial && right.serial) return left.serial === right.serial;
  return !left.serial && !right.serial && left.make === right.make && left.model === right.model;
}

/** An enabled queue wins over a disabled one when several point at the device. */
export function findQueue(
  device: PrinterDevice,
  devices: readonly QueueDevice[],
  enabled: ReadonlyMap<string, boolean>,
): QueueLookup {
  const bound = devices.filter((candidate) => isSameDevice(candidate.deviceUri, device.deviceUri));
  if (bound.length === 0) return { state: "missing", queue: null };
  const ready = bound.find((candidate) => enabled.get(candidate.queue) !== false);
  if (ready) return { state: "ready", queue: ready.queue };
  return { state: "disabled", queue: bound[0].queue };
}
