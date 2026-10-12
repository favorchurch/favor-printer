/**
 * Which screen the setup window shows. Main owns the step (`setupStep`); the
 * window adds only what main does not track: whether the volunteer has tried
 * "Set up printer" and been refused, the last enrollment error, and the test
 * print progress. Kept free of the DOM so it is tested as plain functions.
 */

import {
  ENROLL_CONFLICT_COPY,
  ENROLL_FAILURE_COPY,
  isUsableUsbSerial,
  type AppSnapshot,
  type EnrollConflictReason,
  type EnrollPlainFailure,
  type RenameResult,
  type SetupStep,
  type TestPrintResult,
} from "../shared";

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

export type EnrollFailureReason = EnrollPlainFailure;

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
  /** The cloud refused to bind the printer: why. Set instead of `codeError`, never with it. */
  codeConflict: EnrollConflictReason | null;
  testPrint: TestPrintProgress;
  /** An action is running: its button is disabled. */
  busy: boolean;
  /** The volunteer chose "Move to Favor Printer" and is being asked to confirm. */
  confirmingMigration: boolean;
  /** The last move failed. Printing stays off. */
  migrateError: boolean;
  /** A rename RSVP refused or could not take. `name` is what was typed, so it is not lost on re-render. */
  renameError: { target: RenameTarget; reason: RenameFailureReason; name: string } | null;
};

export const INITIAL_LOCAL: LocalState = {
  setUpRefused: false,
  codeError: null,
  codeConflict: null,
  testPrint: { kind: "idle" },
  busy: false,
  confirmingMigration: false,
  migrateError: false,
  renameError: null,
};

export type RenameTarget = "laptop" | "printer";
export type RenameFailureReason = Extract<RenameResult, { ok: false }>["reason"];

export const RENAME_ERROR_COPY: Record<RenameFailureReason, string> = {
  name_taken: "RSVP already has something with this name. Pick a different name.",
  invalid_name: "RSVP did not accept that name. Try another.",
  not_found: "RSVP no longer links this printer to this laptop. Ask an admin for help.",
  not_enrolled: "This laptop is not connected to RSVP. Enter a code from an admin.",
  printer_not_ready: "The printer has not checked in with RSVP yet. Try again in a moment.",
  revoked: "RSVP removed this laptop. Enter a new code from an admin.",
  unreachable: "Could not reach RSVP. Try again.",
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

export const ENROLL_ERROR_COPY = ENROLL_FAILURE_COPY;

/** What the code screen says about the last failed enrollment, or null when there was none. */
export function codeErrorCopy(local: Pick<LocalState, "codeError" | "codeConflict">): string | null {
  if (local.codeConflict) return ENROLL_CONFLICT_COPY[local.codeConflict];
  return local.codeError ? ENROLL_ERROR_COPY[local.codeError] : null;
}

/** The test print here goes to the local printer only. The cloud check-in path is tested from RSVP. */
export const LOCAL_TEST_COPY = {
  title: "Local hardware test",
  lead: "This sends one test label straight to your Zebra to check the hardware. It does not test check-in.",
  cloudHint: "To test check-in printing from Favor RSVP, use Set up printing in RSVP.",
  confirmLead: "Favor Printer sent the label to the printer. That does not prove a label printed, so check the printer.",
  start: "Print local test label",
} as const;

export const TEST_PRINT_ERROR_COPY: Record<Extract<TestPrintResult, { ok: false }>["reason"], string> = {
  no_printer: "No printer is ready. Plug in the Zebra and check the menu bar icon.",
  printer_not_ready:
    "This printer is not ready yet. Wait a minute and try again. If it keeps happening, ask an admin to check that this printer is enabled in RSVP printing settings.",
  paused: "Printing is paused. Choose Resume printing in the menu, then try again.",
  busy: "The printer is busy with a label. Wait a moment, then try again.",
  failed: "The test label could not be sent. Try again.",
};

/** "Lobby Zebra · Campus ID 7", or null when the cloud did not say which printer this laptop is bound to. */
export function boundPrinterText(snapshot: Pick<AppSnapshot, "printerName" | "campusId">): string | null {
  if (!snapshot.printerName) return null;
  return snapshot.campusId === null ? snapshot.printerName : `${snapshot.printerName} · Campus ID ${snapshot.campusId}`;
}

/** Digits only, at most six: what the code box keeps as the volunteer types or pastes. */
export function cleanCodeInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}
