/**
 * The setup window's steps. The renderer asks to move on (`advance`) and main
 * decides whether the next step is reachable, so the window cannot skip the
 * printer, the code or the test print by calling the API out of order.
 *
 *   welcome -> printer -> code -> connected -> test-print -> done -> (closed)
 */

import { isUsableUsbSerial, type PrinterScan, type SetupStep } from "../../shared";

export type FlowContext = {
  step: SetupStep | null;
  /** A printer is selected and its queue is ready. */
  printerReady: boolean;
  enrolled: boolean;
  revoked: boolean;
  /** The relay has reached the cloud with the saved credentials. */
  cloudOk: boolean;
  testPrintConfirmed: boolean;
  /** The old launchd relay is still loaded. Setup does not go past the welcome until it is moved. */
  legacyLoaded: boolean;
};

export function printerReady(scan: PrinterScan): boolean {
  if (scan.kind !== "found" || scan.queue !== "ready") return false;
  // Enrollment binds the laptop to the USB serial, so a printer without a usable one is not ready.
  return scan.devices.some((device) => device.id === scan.selectedId && isUsableUsbSerial(device.usbSerial));
}

/** The step after `advance`. The same step comes back when the next one is not reachable yet. */
export function advanceStep(context: FlowContext): SetupStep | null {
  switch (context.step) {
    case null:
      // From the red state the volunteer goes straight to a new code: the printer is already set up.
      if (context.revoked) return "code";
      return context.enrolled ? null : "welcome";
    case "welcome":
      return context.legacyLoaded ? "welcome" : "printer";
    case "printer":
      return context.printerReady ? "code" : "printer";
    case "code":
      return context.enrolled ? "connected" : "code";
    case "connected":
      return context.cloudOk ? "test-print" : "connected";
    case "test-print":
      return context.testPrintConfirmed ? "done" : "test-print";
    case "done":
      return null;
  }
}

/** Where the window opens at launch. Null: no window until the volunteer asks. */
export function initialStep(state: { enrolled: boolean; revoked: boolean; setupComplete: boolean }): SetupStep | null {
  if (state.revoked) return null;
  if (!state.enrolled) return "welcome";
  return state.setupComplete ? null : "connected";
}
