/**
 * Parses `lpinfo -v`. Each line is `<class> <uri>`; a Zebra on USB looks like
 *
 *   direct usb://Zebra%20Technologies/ZTC%20ZD421-203dpi%20ZPL?serial=D2J190800123
 *
 * Everything except `direct usb://` lines from a Zebra is ignored.
 */

import type { PrinterDevice } from "../../shared";

export type UsbUri = {
  make: string;
  model: string;
  serial: string | null;
};

/** `decodeURIComponent` that keeps the raw text when the escape is malformed. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Returns null for anything that is not `usb://<make>/<model>[?query]`. */
export function parseUsbUri(uri: string): UsbUri | null {
  const match = uri.match(/^usb:\/\/([^/?]+)\/([^?]*)(?:\?(.*))?$/);
  if (!match) return null;
  const [, make, model, query] = match;

  let serial: string | null = null;
  for (const pair of (query ?? "").split("&")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    // Not URLSearchParams: it would turn a literal '+' in a serial into a space.
    if (decode(pair.slice(0, separator)).toLowerCase() !== "serial") continue;
    const value = decode(pair.slice(separator + 1)).trim();
    if (value) serial = value;
    break;
  }
  return { make: decode(make), model: decode(model), serial };
}

export function isZebraMake(make: string): boolean {
  return /\bzebra\b/i.test(make);
}

/** Zebra USB printers in `lpinfo -v` output, in the order CUPS listed them. */
export function parseLpinfo(stdout: string): PrinterDevice[] {
  const devices: PrinterDevice[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+(\S.*?)\s*$/);
    if (!match || match[1] !== "direct") continue;
    const deviceUri = match[2];
    const usb = parseUsbUri(deviceUri);
    if (!usb || !isZebraMake(usb.make) || seen.has(deviceUri)) continue;
    seen.add(deviceUri);
    devices.push({
      id: deviceUri,
      deviceUri,
      usbSerial: usb.serial,
      // CUPS reports Zebra's "ZTC " model prefix; the volunteer sees the model name.
      model: usb.model.replace(/^ZTC\s+/i, ""),
    });
  }
  return devices;
}
