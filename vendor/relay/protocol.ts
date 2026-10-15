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
  /** Additive: the rejected ids this relay once served and an admin handed over to another host. */
  handedOverPrinterIds?: string[];
};

/**
 * Answer (403) to a claim whose requested printers were all handed over to another host. The relay
 * stays enrolled and keeps its other printers: drop these printers and do not retry the claim.
 */
export type HandedOverResponse = {
  error: "forbidden";
  reason: "printer_handed_over";
  printerIds: string[];
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
  /** Optional. Absent from older clients; unknown values are ignored by the server. */
  hostKind?: "mac" | "ipad";
  /** Optional. "paused" is the last beat an iPad host sends when it goes to the background. Absent means active. */
  lifecycle?: "active" | "paused";
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
  /** Additive: set when this enrollment moved the printer off another host (that host's kind and label, never its id). */
  handedOverFrom?: { hostKind: "mac" | "ipad" | null; label: string | null };
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
  | "printer_name_taken"
  /** The printer's current host is live. The admin must confirm a handover and issue a new code. */
  | "host_active";

/** Answer of POST /api/printing/relay/enroll with status 409 and `error: "printer_conflict"`. */
export type RelayEnrollConflictResponse = {
  error: "printer_conflict";
  reason: RelayEnrollConflictReason;
};

/**
 * Body of POST /api/printing/relay/rename: exactly one rename per request —
 * this laptop's label, or the name of one printer bound to it.
 */
export type RelayRenameRequest =
  | { label: string }
  | { printerId: string; name: string };

/** Answer of POST /api/printing/relay/rename: the fleet identity now stored in the cloud. */
export type RelayRenameResponse = {
  apiVersion: 1;
  relayId: string;
  /** A laptop rename: the label now stored. */
  label?: string | null;
  /** A printer rename: the printer now stored. */
  printer?: { id: string; name: string; usbSerial: string | null };
};

/** Answer of POST /api/printing/relay/rename with status 409: another printer already holds the name. */
export type RelayRenameConflictResponse = {
  error: "name_taken";
  message: string;
};
