/**
 * Which screen the setup window shows. Main owns the step (`setupStep`); the
 * window adds only what main does not track: whether the volunteer has tried
 * "Set up printer" and been refused, the last enrollment error, and the test
 * print progress. Kept free of the DOM so it is tested as plain functions.
 */

import { isUsableUsbSerial, type AppSnapshot, type EnrollResult, type SetupStep, type TestPrintResult } from "../shared";

export type ScreenId =
  | "welcome"
  /** The old relay is loaded: offer to move to Favor Printer. */
  | "legacy"
  /** Asks the volunteer to confirm before anything is turned off. */
  | "legacy-confirm"
  | "printer-none"
  | "printer-several"
  | "printer-no-queue"
  | "printer-fallback"
  | "printer-ready"
  | "code"
  | "connected"
  | "test-print"
  | "done"
  | "revoked"
  | "status";

export type EnrollFailureReason = Extract<EnrollResult, { ok: false }>["reason"];

export type TestPrintProgress =
  | { kind: "idle" }
  | { kind: "sending" }
  /** The relay handed the label to CUPS. Whether paper came out is the volunteer's answer. */
  | { kind: "sent" }
  | { kind: "failed"; reason: Extract<TestPrintResult, { ok: false }>["reason"] }
  | { kind: "no-label" };

export type LocalState = {
  /** "Set up printer" was refused by macOS: show the System Settings guide. */
  setUpRefused: boolean;
  codeError: EnrollFailureReason | null;
  testPrint: TestPrintProgress;
  /** An action is running: its button is disabled. */
  busy: boolean;
  /** The volunteer chose "Move to Favor Printer" and is being asked to confirm. */
  confirmingMigration: boolean;
  /** The last move failed. Printing stays off. */
  migrateError: boolean;
};

export const INITIAL_LOCAL: LocalState = {
  setUpRefused: false,
  codeError: null,
  testPrint: { kind: "idle" },
  busy: false,
  confirmingMigration: false,
  migrateError: false,
};

export const STEP_ORDER: SetupStep[] = ["welcome", "printer", "code", "connected", "test-print", "done"];

export function pickScreen(snapshot: AppSnapshot, local: LocalState): ScreenId {
  const step = snapshot.setupStep;
  // The old relay comes first: nothing else is useful while two relays could claim the same jobs.
  if (snapshot.legacyRelayLoaded && (step === null || step === "welcome")) {
    return local.confirmingMigration ? "legacy-confirm" : "legacy";
  }
  if (step === null) return snapshot.status.color === "red" ? "revoked" : "status";
  switch (step) {
    case "welcome":
      return "welcome";
    case "printer": {
      const { printer } = snapshot;
      if (printer.kind === "none") return "printer-none";
      if (printer.selectedId === null) return "printer-several";
      const selected = printer.devices.find((device) => device.id === printer.selectedId);
      // Enrollment needs the USB serial: without one, ask for the printer to be plugged in.
      if (!selected || !isUsableUsbSerial(selected.usbSerial)) return "printer-none";
      if (printer.queue === "ready") return "printer-ready";
      return local.setUpRefused ? "printer-fallback" : "printer-no-queue";
    }
    case "code":
      return "code";
    case "connected":
      return "connected";
    case "test-print":
      return "test-print";
    case "done":
      return "done";
  }
}

/** "Step 2 of 5" for the five steps after the welcome. Null where a count would mislead. */
export function stepLabel(step: SetupStep | null): string | null {
  if (step === null || step === "welcome") return null;
  return `Step ${STEP_ORDER.indexOf(step)} of ${STEP_ORDER.length - 1}`;
}

export const ENROLL_ERROR_COPY: Record<EnrollFailureReason, string> = {
  invalid_code: "That code did not work. It may have expired. Ask an admin for a new one.",
  throttled: "Too many tries. Wait a few minutes, then enter the code again.",
  disabled: "Enrolling is turned off right now. Ask an admin for help.",
  unreachable: "Could not reach Favor RSVP. Check the internet connection and try again.",
  printer_not_found: "We cannot see your Zebra printer. Check that it is turned on and plugged in, then try again.",
  invalid_request: "The app could not send that request. Update Favor Printer and try again.",
};

export const TEST_PRINT_ERROR_COPY: Record<Extract<TestPrintResult, { ok: false }>["reason"], string> = {
  no_printer: "No printer is ready. Plug in the Zebra and check the menu bar icon.",
  printer_not_ready:
    "This printer is not ready yet. Wait a minute and try again. If it keeps happening, ask an admin to check that this printer is enabled in RSVP printing settings.",
  paused: "Printing is paused. Choose Resume printing in the menu, then try again.",
  busy: "The printer is busy with a label. Wait a moment, then try again.",
  failed: "The test label could not be sent. Try again.",
};

/** Digits only, at most six: what the code box keeps as the volunteer types or pastes. */
export function cleanCodeInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}
