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
