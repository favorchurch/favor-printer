import { describe, expect, it } from "vitest";

import { createMockApi, FIXTURE_NAMES, fixtureFor } from "./fixtures";
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
  revoked: "revoked",
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

  it("carries no real names, codes or tokens", () => {
    const text = JSON.stringify(FIXTURE_NAMES.map((name) => fixtureFor(name)));
    expect(text).not.toMatch(/token|\^XA|rock\.favor/i);
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
