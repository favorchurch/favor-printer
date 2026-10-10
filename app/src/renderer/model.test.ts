import { describe, expect, it } from "vitest";

import { ENROLLMENT_CODE_PATTERN } from "../shared";
import type { AppSnapshot, PrinterScan } from "../shared";
import { LEGACY_FAILED_DETAIL } from "../main/shell/controller";
import { LEGACY_FAILED_COPY } from "./screens";
import { snapshotFor } from "../main/shell/testing/snapshot";
import {
  cleanCodeInput,
  ENROLL_ERROR_COPY,
  INITIAL_LOCAL,
  pickScreen,
  stepLabel,
  STEP_ORDER,
  TEST_PRINT_ERROR_COPY,
  type LocalState,
} from "./model";

const device = (id: string) => ({ id, deviceUri: id, usbSerial: "D2J190800123", model: "ZD421" });
const found = (patch: Partial<Extract<PrinterScan, { kind: "found" }>> = {}): PrinterScan => ({
  kind: "found",
  devices: [device("a")],
  selectedId: "a",
  queue: "ready",
  ...patch,
});

const pick = (patch: Partial<AppSnapshot>, local: Partial<LocalState> = {}) => pickScreen(snapshotFor(patch), { ...INITIAL_LOCAL, ...local });

describe("pickScreen", () => {
  it("follows main's setup step", () => {
    expect(pick({ setupStep: "welcome" })).toBe("welcome");
    expect(pick({ setupStep: "code" })).toBe("code");
    expect(pick({ setupStep: "connected" })).toBe("connected");
    expect(pick({ setupStep: "test-print" })).toBe("test-print");
    expect(pick({ setupStep: "done" })).toBe("done");
  });

  describe("printer step", () => {
    it("shows plug-in guidance for a printer with no usable serial, even with a ready queue", () => {
      const noSerial = found({ devices: [{ ...device("a"), usbSerial: null }] });
      expect(pick({ setupStep: "printer", printer: noSerial })).toBe("printer-none");
    });

    it("shows plug-in guidance when no printer is seen", () => {
      expect(pick({ setupStep: "printer", printer: { kind: "none" } })).toBe("printer-none");
    });

    it("asks which one when several are connected and none is chosen", () => {
      const printer = found({ devices: [device("a"), device("b")], selectedId: null, queue: "missing" });
      expect(pick({ setupStep: "printer", printer })).toBe("printer-several");
    });

    it("offers set up when the printer has no queue", () => {
      expect(pick({ setupStep: "printer", printer: found({ queue: "missing" }) })).toBe("printer-no-queue");
    });

    it("offers set up when the queue is turned off", () => {
      expect(pick({ setupStep: "printer", printer: found({ queue: "disabled" }) })).toBe("printer-no-queue");
    });

    it("guides the volunteer to System Settings once macOS refused", () => {
      expect(pick({ setupStep: "printer", printer: found({ queue: "missing" }) }, { setUpRefused: true })).toBe("printer-fallback");
    });

    it("is ready once the queue is", () => {
      expect(pick({ setupStep: "printer", printer: found() })).toBe("printer-ready");
    });

    it("does not show the fallback for a printer that is already ready", () => {
      expect(pick({ setupStep: "printer", printer: found() }, { setUpRefused: true })).toBe("printer-ready");
    });
  });

  describe("legacy relay", () => {
    const legacy = { legacyRelayLoaded: true };

    it("offers the move at the welcome step", () => {
      expect(pick({ ...legacy, setupStep: "welcome" })).toBe("legacy");
    });

    it("offers the move outside setup too", () => {
      expect(pick({ ...legacy, setupStep: null })).toBe("legacy");
    });

    it("asks for confirmation only after the volunteer chose to move", () => {
      expect(pick({ ...legacy, setupStep: "welcome" }, { confirmingMigration: true })).toBe("legacy-confirm");
      expect(pick({ ...legacy, setupStep: "welcome" }, { confirmingMigration: false })).toBe("legacy");
    });

    it("stays on the offer, with the error, after a failed move", () => {
      expect(pick({ ...legacy, setupStep: "welcome" }, { migrateError: true })).toBe("legacy");
    });

    it("comes before the revoked screen, because two relays must not run", () => {
      expect(pick({ ...legacy, setupStep: null, status: { color: "red", headline: "x", detail: null } })).toBe("legacy");
    });

    it("is gone once the old relay is, and the confirmation flag alone shows nothing", () => {
      expect(pick({ legacyRelayLoaded: false, setupStep: "welcome" }, { confirmingMigration: true })).toBe("welcome");
    });
  });

  describe("outside setup", () => {
    it("shows the revoked screen in the red state", () => {
      expect(pick({ setupStep: null, status: { color: "red", headline: "x", detail: null } })).toBe("revoked");
    });

    it("moves from the revoked screen to the code once main opens that step", () => {
      expect(pick({ setupStep: "code", status: { color: "red", headline: "x", detail: null } })).toBe("code");
    });

    it("shows a plain status page otherwise", () => {
      expect(pick({ setupStep: null })).toBe("status");
    });
  });
});

describe("stepLabel", () => {
  it("counts the five steps after the welcome", () => {
    expect(STEP_ORDER.slice(1).map(stepLabel)).toEqual(["Step 1 of 5", "Step 2 of 5", "Step 3 of 5", "Step 4 of 5", "Step 5 of 5"]);
  });

  it("shows no count on the welcome or outside setup", () => {
    expect(stepLabel("welcome")).toBeNull();
    expect(stepLabel(null)).toBeNull();
  });
});

describe("cleanCodeInput", () => {
  it.each([
    ["123456", "123456"],
    ["12 34-56", "123456"],
    ["abc123", "123"],
    ["1234567890", "123456"],
    ["", ""],
    ["١٢٣", ""],
  ])("%j -> %j", (input, expected) => {
    expect(cleanCodeInput(input)).toBe(expected);
  });

  it("only ever produces something the code pattern can accept", () => {
    expect(ENROLLMENT_CODE_PATTERN.test(cleanCodeInput("12-34 56"))).toBe(true);
  });
});

describe("copy", () => {
  it("has clear text for every enrollment failure, matching the cloud's contract", () => {
    expect(Object.keys(ENROLL_ERROR_COPY).sort()).toEqual(["disabled", "invalid_code", "invalid_request", "printer_not_found", "throttled", "unreachable"]);
    expect(ENROLL_ERROR_COPY.invalid_code).toMatch(/expired/i);
    expect(ENROLL_ERROR_COPY.throttled).toMatch(/wait/i);
    expect(ENROLL_ERROR_COPY.printer_not_found).toBe("We cannot see your Zebra printer. Check that it is turned on and plugged in, then try again.");
  });

  it("has clear text for every test print failure", () => {
    expect(Object.keys(TEST_PRINT_ERROR_COPY).sort()).toEqual(["busy", "failed", "no_printer", "paused", "printer_not_ready"]);
  });

  it("is neutral when the printer is not ready: retry first, ask an admin only if it persists, never plug it in", () => {
    const copy = TEST_PRINT_ERROR_COPY.printer_not_ready;
    expect(copy).toMatch(/is not ready yet/i);
    expect(copy).toMatch(/wait a minute and try again/i);
    expect(copy).toMatch(/if it keeps happening, ask an admin/i);
    expect(copy).not.toMatch(/turned (on|off)/i);
    expect(copy).not.toMatch(/plug/i);
    expect(copy).not.toBe(TEST_PRINT_ERROR_COPY.no_printer);
  });
});

describe("legacy failure copy", () => {
  it("is the same text in the window and under the tray status", () => {
    expect(LEGACY_FAILED_COPY).toBe(LEGACY_FAILED_DETAIL);
  });
});
