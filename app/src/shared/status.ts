/**
 * What the tray and the setup window show. Derived in main from relay, cloud,
 * printer, update and pause state, then sent to the renderer as is.
 * Nothing here carries names, ZPL or security codes: counts, states and copy only.
 */

import type { UpdateChannel } from "./constants";

export type StatusColor = "green" | "amber" | "red";

export type StatusSummary = {
  color: StatusColor;
  headline: string;
  /** One line of help under the headline, when there is something to do. */
  detail: string | null;
};

export type JobCounts = {
  sent: number;
  failed: number;
  /** Sent to the printer but not confirmed: an operator should look at the label stock. */
  ambiguous: number;
};

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading" }
  /** Downloaded. Installs when the app quits with no job in flight. */
  | { kind: "ready"; version: string }
  | { kind: "error" };

export type SetupStep = "welcome" | "printer" | "code" | "connected" | "test-print" | "done";

/** A Zebra seen on USB. The serial is what enrollment binds the laptop to. */
export type PrinterDevice = {
  id: string;
  deviceUri: string;
  usbSerial: string | null;
  model: string;
};

export type QueueState = "ready" | "missing" | "disabled";

export type PrinterScan =
  | { kind: "none" }
  | { kind: "found"; devices: PrinterDevice[]; selectedId: string | null; queue: QueueState };

export type AppSnapshot = {
  version: string;
  status: StatusSummary;
  enrolled: boolean;
  /** Admin-chosen label of this laptop, shown in the menu. */
  label: string | null;
  paused: boolean;
  openAtLogin: boolean;
  channel: UpdateChannel;
  update: UpdateState;
  recentJobs: JobCounts;
  setupStep: SetupStep | null;
  printer: PrinterScan;
  /** Set while the legacy launchd relay is loaded and the migration is still to do. */
  legacyRelayLoaded: boolean;
  /** Lid, sleep and battery warnings. Never claims printing works with the lid closed. */
  warnings: string[];
};
