import { describe, expect, it } from "vitest";

import type { PrinterScan, SetupStep } from "../../shared";
import { advanceStep, initialStep, printerReady, type FlowContext } from "./setupFlow";

const context = (patch: Partial<FlowContext>): FlowContext => ({
  step: null,
  printerReady: false,
  enrolled: false,
  revoked: false,
  cloudOk: false,
  testPrintConfirmed: false,
  ...patch,
});

describe("advanceStep", () => {
  it.each<[SetupStep, Partial<FlowContext>, SetupStep | null]>([
    ["welcome", {}, "printer"],
    ["printer", { printerReady: false }, "printer"],
    ["printer", { printerReady: true }, "code"],
    ["code", { enrolled: false }, "code"],
    ["code", { enrolled: true }, "connected"],
    ["connected", { enrolled: true, cloudOk: false }, "connected"],
    ["connected", { enrolled: true, cloudOk: true }, "test-print"],
    ["test-print", { testPrintConfirmed: false }, "test-print"],
    ["test-print", { testPrintConfirmed: true }, "done"],
    ["done", {}, null],
  ])("%s with %j goes to %s", (step, patch, expected) => {
    expect(advanceStep(context({ step, ...patch }))).toBe(expected);
  });

  it("does not let a ready printer skip the code", () => {
    expect(advanceStep(context({ step: "welcome", printerReady: true, cloudOk: true, testPrintConfirmed: true }))).toBe("printer");
  });

  it("starts setup from nothing when not enrolled", () => {
    expect(advanceStep(context({ step: null }))).toBe("welcome");
  });

  it("stays closed when enrolled", () => {
    expect(advanceStep(context({ step: null, enrolled: true }))).toBeNull();
  });

  it("goes straight to a new code from the red state", () => {
    expect(advanceStep(context({ step: null, revoked: true }))).toBe("code");
  });
});

describe("initialStep", () => {
  it.each([
    [{ enrolled: false, revoked: false, setupComplete: false }, "welcome"],
    [{ enrolled: false, revoked: false, setupComplete: true }, "welcome"],
    [{ enrolled: true, revoked: false, setupComplete: false }, "connected"],
    [{ enrolled: true, revoked: false, setupComplete: true }, null],
    [{ enrolled: false, revoked: true, setupComplete: true }, null],
    [{ enrolled: true, revoked: true, setupComplete: false }, null],
  ] as const)("%j -> %s", (state, expected) => {
    expect(initialStep(state)).toBe(expected);
  });
});

describe("printerReady", () => {
  const device = { id: "a", deviceUri: "a", usbSerial: null, model: "ZD421" };
  it.each<[string, PrinterScan, boolean]>([
    ["none", { kind: "none" }, false],
    ["several, none chosen", { kind: "found", devices: [device, { ...device, id: "b" }], selectedId: null, queue: "missing" }, false],
    ["no queue", { kind: "found", devices: [device], selectedId: "a", queue: "missing" }, false],
    ["queue disabled", { kind: "found", devices: [device], selectedId: "a", queue: "disabled" }, false],
    ["ready", { kind: "found", devices: [device], selectedId: "a", queue: "ready" }, true],
  ])("%s -> %s", (_name, scan, expected) => {
    expect(printerReady(scan)).toBe(expected);
  });
});
