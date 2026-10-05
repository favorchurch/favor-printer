/**
 * Messages between a host app and `relay/embedded.ts`, the relay run as a
 * child process (Electron `utilityProcess`, or Node `child_process.fork`).
 * Types and parsing only, so importing this never starts anything.
 */

import type { EmbeddedRelayOptions } from "./index";
import type { RelayErrorCode, RelayEvent } from "./status";

/** `start` options as they cross the process boundary: data only, no callbacks. */
export type EmbeddedStartOptions = Omit<
  EmbeddedRelayOptions,
  | "printerAttached"
  | "logger"
  | "onEvent"
  | "fetch"
  | "transportOverride"
  | "now"
> & {
  /** Initial value. Update it later with `printerAttached` messages. */
  printerAttached?: boolean;
};

export type ParentMessage =
  | { type: "start"; options: EmbeddedStartOptions }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "testPrint"; printerId: string }
  | { type: "printerAttached"; attached: boolean };

export type ChildMessage =
  | { type: "event"; event: RelayEvent }
  /** The relay has finished everything it was doing and the process is about to exit. */
  | { type: "stopped" }
  | { type: "error"; code: RelayErrorCode | "bad_message" }
  | {
      type: "testPrintResult";
      printerId: string;
      ok: boolean;
      /** `sent` = the transport accepted the label (CUPS took it), not proof of paper. */
      transportOutcome?: "sent" | "unsent" | "ambiguous";
      /** Set when nothing was attempted: unknown_printer, paused, busy, or a cloud error code. */
      error?: string;
    };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

/** Returns the message when it is well formed, else null. Start options are checked by the relay itself. */
export function parseParentMessage(raw: unknown): ParentMessage | null {
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case "start": {
      const o = raw.options;
      if (!isObject(o)) return null;
      const t = o.transport;
      const transportOk =
        isObject(t) && (t.kind === "tcp" || (t.kind === "cups" && isString(t.queue)));
      const ok =
        transportOk &&
        isString(o.apiUrl) &&
        isString(o.relayId) &&
        isString(o.token) &&
        isString(o.spoolDir) &&
        isString(o.appVersion) &&
        isString(o.osVersion);
      return ok ? { type: "start", options: o as unknown as EmbeddedStartOptions } : null;
    }
    case "pause":
    case "resume":
    case "stop":
      return { type: raw.type };
    case "testPrint":
      return isString(raw.printerId) ? { type: "testPrint", printerId: raw.printerId } : null;
    case "printerAttached":
      return typeof raw.attached === "boolean"
        ? { type: "printerAttached", attached: raw.attached }
        : null;
    default:
      return null;
  }
}
