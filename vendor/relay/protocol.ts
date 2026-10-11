/**
 * Wire types shared with the cloud relay API (src/lib/printing/relayApi.ts).
 * Duplicated rather than imported so the relay stays a standalone program that
 * can be copied to a venue machine with nothing but Node.
 */

export type PrinterTarget = { host: string; port: number };

export type ClaimedJob = PrinterTarget & {
  id: string;
  printerId: string;
  label: string;
  copy: number;
  zpl: string;
  claimToken: string;
  leaseExpiresAt: string;
  attempt: number;
};

export type ClaimResponse = {
  jobs: ClaimedJob[];
  rejectedPrinterIds: string[];
};

export type PrinterProbe = {
  printerId: string;
  reachable: boolean;
  checkedAt: string;
  error?: string;
  /** Set by transports that cannot read printer status (USB via CUPS). */
  status?: "status_unknown";
};

export type HeartbeatRequest = {
  printerIds: string[];
  relayVersion: string;
  spoolDepth: number;
  probes: PrinterProbe[];
  /** Sent by the Favor Printer app only; the env-mode relay omits them. */
  appVersion?: string;
  osVersion?: string;
  printerAttached?: boolean;
};

export type HeartbeatResponse = {
  ok: true;
  serverTime: string;
  printers: Array<PrinterTarget & { id: string; name: string; enabled: boolean }>;
};

export type ReportOutcome = "sent" | "failed" | "ambiguous";

/** Answer of POST /api/printing/relay/test-print: the cloud renders the label, the relay prints it locally. */
export type RelayTestPrintResponse = {
  apiVersion: 1;
  testId: string;
  printerId: string;
  zpl: string;
};

/** Answer of POST /api/printing/relay/config: what this relay is enrolled to serve. */
export type RelayConfigResponse = {
  apiVersion: 1;
  relayId: string;
  label: string;
  printerIds: string[];
  printers: Array<{ id: string; name: string; usbSerial?: string }>;
};

/** Answer of POST /api/printing/relay/enroll (no credentials: the one-time code is the credential). */
export type RelayEnrollResponse = {
  apiVersion: 1;
  relayId: string;
  token: string;
  label: string | null;
  /**
   * The printer this laptop was bound to. `id`, `name` and `usbSerial` are what
   * every build has always received; `campusId` is additive and may be absent
   * from an older cloud. Null when the printer has no campus.
   */
  printer: { id: string; name: string; usbSerial: string | null; campusId?: number | null };
};

/**
 * Why the cloud refused to bind this laptop to the printer the code was issued
 * for. Nothing was changed and the code is still valid: fix the cause (or issue
 * a new code) and enroll again. A reason never names another printer or serial.
 */
export type RelayEnrollConflictReason =
  | "target_not_found"
  | "target_disabled"
  | "campus_mismatch"
  | "target_serial_mismatch"
  | "serial_other_campus"
  | "serial_duplicate_has_jobs"
  | "serial_in_use"
  | "printer_name_taken";

/** Answer of POST /api/printing/relay/enroll with status 409 and `error: "printer_conflict"`. */
export type RelayEnrollConflictResponse = {
  error: "printer_conflict";
  reason: RelayEnrollConflictReason;
};
