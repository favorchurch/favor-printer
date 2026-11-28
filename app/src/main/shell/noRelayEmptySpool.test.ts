import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { propertyParams } from "../../shared/testing/property";
import { createFakeTimers } from "../services/testing/fakes";
import { createUpdateController, type UpdaterAdapter, type UpdaterEvent } from "../services/updates";
import { createControllerHarness, CREDENTIALS, foundPrinter, type HarnessOptions } from "./testing/controllerHarness";

/** Entries a relay can leave in its spool, and one the app does not know. */
const RESIDUE = [
  ["a job record", "job-1.json"],
  ["a send marker", "job-1.send"],
  ["a temp file", "job-1.json.4242.0a1b2c.tmp"],
  ["the relay lock", ".relay.lock"],
  ["a quarantined record", "job-2.json.corrupt"],
  ["an unknown file", "notes.txt"],
] as const;

type Pairing = "never" | "revoked" | "enrolled";
type EnrollOutcome = Awaited<ReturnType<NonNullable<HarnessOptions["enroll"]>>>;

/** A controller on a real support folder, initialized the way the app starts it. */
async function started(appSupportDir: string, pairing: Pairing, extra: Pick<HarnessOptions, "scan" | "updates"> = {}) {
  const h = createControllerHarness({
    ...extra,
    appSupportDir,
    credentials: pairing === "never" ? null : CREDENTIALS,
    prefs: { openAtLogin: true, setupComplete: true, revoked: pairing === "revoked" },
  });
  await h.controller.initialize();
  return h;
}

/** The real update policy with a downloaded update already offered, and no install-on-quit check until a controller registers one. */
function policy() {
  let listener: (event: UpdaterEvent) => void = () => undefined;
  const adapter: UpdaterAdapter = {
    configure: vi.fn(),
    subscribe: (next) => void (listener = next),
    check: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  };
  const updates = createUpdateController({ adapter, channel: "stable", timers: createFakeTimers().timers });
  listener({ kind: "downloaded", version: "0.2.0" });
  return { updates, installs: () => vi.mocked(adapter.quitAndInstall).mock.calls.length };
}

describe("noRelayEmptySpool on a real support folder", () => {
  let root: string;
  let spool: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "no-relay-spool-"));
    spool = path.join(root, "spool");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is false before initialize has read the pairing", () => {
    const h = createControllerHarness({ appSupportDir: root });
    expect(h.controller.noRelayEmptySpool()).toBe(false);
  });

  it("is true for a Mac that never enrolled, with no spool folder, and creates none", async () => {
    const h = await started(root, "never");
    expect(h.controller.noRelayEmptySpool()).toBe(true);
    expect(existsSync(spool)).toBe(false);
  });

  it("is true for a revoked Mac with an empty spool folder", async () => {
    mkdirSync(spool);
    const h = await started(root, "revoked");
    expect(h.controller.noRelayEmptySpool()).toBe(true);
  });

  it("is false for an enrolled Mac, even with an empty spool folder", async () => {
    mkdirSync(spool);
    const h = await started(root, "enrolled");
    expect(h.controller.noRelayEmptySpool()).toBe(false);
  });

  it.each(RESIDUE)("is false for a revoked Mac with %s in the spool, and leaves it there", async (_label, file) => {
    mkdirSync(spool);
    writeFileSync(path.join(spool, file), "{}");
    const h = await started(root, "revoked");
    expect(h.controller.noRelayEmptySpool()).toBe(false);
    expect(readdirSync(spool)).toEqual([file]);
  });

  it("is false for a revoked Mac when the spool path is a file, not a folder", async () => {
    writeFileSync(spool, "x");
    const h = await started(root, "revoked");
    expect(h.controller.noRelayEmptySpool()).toBe(false);
  });

  it("reads the spool on each call, so residue that appears after a true answer makes the next one false", async () => {
    const h = await started(root, "never");
    expect(h.controller.noRelayEmptySpool()).toBe(true);
    mkdirSync(spool);
    writeFileSync(path.join(spool, ".relay.lock"), "{}");
    expect(h.controller.noRelayEmptySpool()).toBe(false);
    rmSync(path.join(spool, ".relay.lock"));
    expect(h.controller.noRelayEmptySpool()).toBe(true);
  });

  it("is false while the relay still runs, even once the pairing reads as revoked, and true after it stops", async () => {
    mkdirSync(spool);
    const h = await started(root, "enrolled", { scan: foundPrinter() });
    expect(h.forks.children).toHaveLength(1);

    await h.prefs.update({ revoked: true });
    expect(h.controller.noRelayEmptySpool()).toBe(false);

    const stopping = h.controller.shutdown();
    h.forks.last().emitMessage({ type: "stopped" });
    h.forks.last().emitExit(0);
    await stopping;
    expect(h.controller.noRelayEmptySpool()).toBe(true);
  });

  it("is false while an enrollment is under way, and true again once it fails", async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const h = createControllerHarness({
      appSupportDir: root,
      prefs: { openAtLogin: true, setupComplete: true },
      enroll: async () => {
        await held;
        return { ok: false, reason: "disabled" } as EnrollOutcome;
      },
    });
    await h.controller.initialize();

    const enrolling = h.controller.enroll("123456");
    expect(h.controller.noRelayEmptySpool()).toBe(false);
    finish();
    await enrolling;
    expect(h.controller.noRelayEmptySpool()).toBe(true);
  });

  it("is what the controller registers with the update policy it is given", async () => {
    const { updates, installs } = policy();
    await started(root, "never", { updates });
    expect(updates.beforeQuit(false, 0, "pending")).toBe("install");
    expect(installs()).toBe(1);
  });

  it("holds a downloaded update while the spool has a job record, and installs at the next settle once it is empty", async () => {
    mkdirSync(spool);
    writeFileSync(path.join(spool, "job-1.json"), "{}");
    const { updates, installs } = policy();
    await started(root, "revoked", { updates });

    expect(updates.beforeQuit(false, 0, "pending")).toBe("defer");
    expect(installs()).toBe(0);

    rmSync(path.join(spool, "job-1.json"));
    updates.jobsSettled(false, 0, "pending");
    expect(installs()).toBe(1);
  });
});

describe("install at quit through the real controller", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "no-relay-spool-prop-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("installs at quit exactly when no job or entry blocks it, and the spool or the reconciliation rule allows it", async () => {
    const residueNames = RESIDUE.map(([, file]) => file);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Pairing>("never", "revoked", "enrolled"),
        fc.uniqueArray(fc.constantFrom(...residueNames), { maxLength: 3 }),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(0, 1),
        async (pairing, files, reconciled, jobInFlight, pending) => {
          const run = mkdtempSync(path.join(root, "run-"));
          const folder = path.join(run, "spool");
          mkdirSync(folder);
          for (const file of files) writeFileSync(path.join(folder, file), "{}");
          // A relay reports `complete` only after a clean stop, and a clean stop leaves no entries in the spool.
          const reconciliation = reconciled && files.length === 0 ? "complete" : "pending";

          const { updates, installs } = policy();
          await started(run, pairing, { updates });
          const unpaired = pairing !== "enrolled";
          const expectInstall = !jobInFlight && pending === 0 && ((unpaired && files.length === 0) || reconciliation === "complete");

          expect(updates.beforeQuit(jobInFlight, pending, reconciliation)).toBe(expectInstall ? "install" : "defer");
          expect(installs()).toBe(expectInstall ? 1 : 0);
        },
      ),
      propertyParams(100),
    );
  });
});
