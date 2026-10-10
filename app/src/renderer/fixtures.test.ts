import { describe, expect, it } from "vitest";

import { createMockApi, FIXTURE_NAMES, fixtureFor, normalizeFixtureName, stateFromLocation } from "./fixtures";
import { INITIAL_LOCAL, pickScreen, type ScreenId } from "./model";

const EXPECTED: Record<(typeof FIXTURE_NAMES)[number], ScreenId> = {
  default: "welcome",
  "no-printer": "printer-none",
  "several-printers": "printer-several",
  "queue-fallback": "printer-fallback",
  "enter-code": "code",
  "invalid-code": "code",
  connected: "connected",
  "test-print-confirm": "test-print",
  done: "done",
  revoked: "revoked",
  "legacy-relay": "legacy",
  "legacy-confirm": "legacy-confirm",
  "legacy-failed": "legacy",
  status: "status",
  "update-ready": "status",
  "update-error": "status",
};

describe("fixture states used by the visual check", () => {
  it.each(FIXTURE_NAMES)("?state=%s opens the right screen", (name) => {
    const { snapshot, local } = fixtureFor(name);
    expect(pickScreen(snapshot, { ...INITIAL_LOCAL, ...local })).toBe(EXPECTED[name]);
  });

  it("falls back to the welcome screen for no state or an unknown one", () => {
    expect(fixtureFor(null).snapshot.setupStep).toBe("welcome");
    expect(fixtureFor("nope").snapshot.setupStep).toBe("welcome");
  });

  it("shows the invalid code error and the confirmation question where the states say so", () => {
    expect(fixtureFor("invalid-code").local).toMatchObject({ codeError: "invalid_code" });
    expect(fixtureFor("test-print-confirm").local).toMatchObject({ testPrint: { kind: "sent" } });
  });

  it("uses the red copy for the revoked state", () => {
    expect(fixtureFor("revoked").snapshot.status).toMatchObject({
      color: "red",
      headline: "This laptop was removed. Ask an admin for a new code.",
    });
  });

  it("provides done, status, update-ready, and update-error fixtures with expected properties", () => {
    expect(fixtureFor("done").snapshot.setupStep).toBe("done");
    expect(fixtureFor("status").snapshot.update).toEqual({ kind: "idle" });
    expect(fixtureFor("update-ready").snapshot.update).toEqual({ kind: "ready", version: "0.2.0" });
    expect(fixtureFor("update-error").snapshot.update).toEqual({ kind: "error" });
  });

  it("carries no real names, codes or tokens", () => {
    const text = JSON.stringify(FIXTURE_NAMES.map((name) => fixtureFor(name)));
    expect(text).not.toMatch(/token|\^XA|rock\.favor/i);
  });
});

describe("legacy relay fixtures", () => {
  it("offers the move, asks for confirmation, and shows the failure", () => {
    expect(fixtureFor("legacy-relay").snapshot).toMatchObject({ legacyRelayLoaded: true, setupStep: "welcome" });
    expect(fixtureFor("legacy-confirm").local).toMatchObject({ confirmingMigration: true });
    expect(fixtureFor("legacy-failed")).toMatchObject({ local: { migrateError: true }, failMigration: true });
  });

  it("the mock moves the old relay only when asked, and the failure fixture refuses", async () => {
    const ok = createMockApi(fixtureFor("legacy-relay").snapshot);
    await expect(ok.migrateLegacyRelay()).resolves.toEqual({ ok: true });
    expect((await ok.getSnapshot()).legacyRelayLoaded).toBe(false);

    const failing = fixtureFor("legacy-failed");
    const api = createMockApi(failing.snapshot, { failMigration: failing.failMigration });
    await expect(api.migrateLegacyRelay()).resolves.toEqual({ ok: false, reason: "bootout_failed" });
    expect((await api.getSnapshot()).legacyRelayLoaded).toBe(true);
  });
});

describe("state names", () => {
  it.each([
    ["several", "several-printers"],
    ["fallback", "queue-fallback"],
    ["code", "enter-code"],
    ["invalid", "invalid-code"],
    ["test", "test-print-confirm"],
    ["legacy", "legacy-relay"],
    ["No-Printer", "no-printer"],
    ["enter_code", "enter-code"],
    ["  revoked ", "revoked"],
    ["nonsense", "default"],
    [null, "default"],
  ] as const)("%j opens %s", (requested, expected) => {
    expect(normalizeFixtureName(requested)).toBe(expected);
  });

  it("every state name opens a different screen from the welcome, except the welcome itself", () => {
    for (const name of FIXTURE_NAMES.filter((state) => state !== "default")) {
      const { snapshot, local } = fixtureFor(name);
      expect(pickScreen(snapshot, { ...INITIAL_LOCAL, ...local })).not.toBe("welcome");
    }
  });

  it("reads the state from the query or the hash", () => {
    expect(stateFromLocation("?state=revoked", "")).toBe("revoked");
    expect(stateFromLocation("", "#state=several")).toBe("several");
    expect(stateFromLocation("", "#fallback")).toBe("fallback");
    expect(stateFromLocation("?state=code", "#state=revoked")).toBe("code");
    expect(stateFromLocation("", "")).toBeNull();
    expect(stateFromLocation("?other=1", "#x=1")).toBeNull();
  });
});

describe("mock API", () => {
  it("walks the steps in order and then closes", async () => {
    const api = createMockApi(fixtureFor("default").snapshot);
    const steps: (string | null)[] = [];
    for (let i = 0; i < 6; i += 1) steps.push((await api.advance()).setupStep);
    expect(steps).toEqual(["printer", "code", "connected", "test-print", "done", null]);
  });

  it("rejects the sample bad code and accepts another", async () => {
    const api = createMockApi(fixtureFor("enter-code").snapshot);
    await expect(api.enroll("000000")).resolves.toEqual({ ok: false, reason: "invalid_code" });
    await expect(api.enroll("123456")).resolves.toEqual({ ok: true });
    expect((await api.getSnapshot()).enrolled).toBe(true);
  });

  it("pushes snapshots to subscribers until they unsubscribe", async () => {
    const api = createMockApi(fixtureFor("default").snapshot);
    const seen: unknown[] = [];
    const off = api.onSnapshot((snapshot) => seen.push(snapshot.setupStep));
    await api.advance();
    off();
    await api.advance();
    expect(seen).toEqual(["printer"]);
  });
});
