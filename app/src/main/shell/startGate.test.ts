import { describe, expect, it, vi } from "vitest";

import { createStartResolver, type StartGateDeps } from "./startGate";

function deps(patch: Partial<StartGateDeps> = {}): StartGateDeps {
  return {
    isRevoked: () => false,
    secrets: { load: vi.fn(async () => ({ relayId: "relay-1", token: "tok-secret" })) },
    legacy: { canStartRelay: vi.fn(async () => ({ allowed: true }) as const) },
    queue: () => "Favor_Zebra",
    printerAttached: () => true,
    appSupportDir: "/Users/v/Library/Application Support/Favor Printer",
    appVersion: "0.1.0",
    osVersion: "macOS 15",
    ...patch,
  };
}

describe("createStartResolver", () => {
  it("builds the relay's start options in memory when everything is in place", async () => {
    const result = await createStartResolver(deps())();
    expect(result).toEqual({
      ok: true,
      options: {
        apiUrl: "https://rsvp.favor.church",
        relayId: "relay-1",
        token: "tok-secret",
        spoolDir: "/Users/v/Library/Application Support/Favor Printer/spool",
        transport: { kind: "cups", queue: "Favor_Zebra" },
        appVersion: "0.1.0",
        osVersion: "macOS 15",
        printerAttached: true,
      },
    });
  });

  it("refuses while the legacy agent is loaded, and does not read the token", async () => {
    const d = deps({ legacy: { canStartRelay: vi.fn(async () => ({ allowed: false, reason: "legacy_loaded" }) as const) } });
    await expect(createStartResolver(d)()).resolves.toEqual({ ok: false, reason: "legacy_loaded" });
    expect(d.secrets.load).not.toHaveBeenCalled();
  });

  it.each(["bootout_failed", "disable_failed"] as const)("refuses after a failed migration: %s", async (reason) => {
    const d = deps({ legacy: { canStartRelay: async () => ({ allowed: false, reason }) } });
    await expect(createStartResolver(d)()).resolves.toEqual({ ok: false, reason: "legacy_loaded" });
  });

  it("refuses when this laptop was revoked, before anything else is asked", async () => {
    const d = deps({ isRevoked: () => true });
    await expect(createStartResolver(d)()).resolves.toEqual({ ok: false, reason: "revoked" });
    expect(d.legacy.canStartRelay).not.toHaveBeenCalled();
    expect(d.secrets.load).not.toHaveBeenCalled();
  });

  it("refuses when not enrolled", async () => {
    const d = deps({ secrets: { load: async () => null } });
    await expect(createStartResolver(d)()).resolves.toEqual({ ok: false, reason: "not_enrolled" });
  });

  it("refuses without a queue", async () => {
    await expect(createStartResolver(deps({ queue: () => null }))()).resolves.toEqual({ ok: false, reason: "no_queue" });
  });

  it("refuses a queue name the relay would reject, without echoing the token", async () => {
    const result = await createStartResolver(deps({ queue: () => "bad queue; rm -rf /" }))();
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("tok-secret");
  });

  it("refuses an insecure API URL", async () => {
    await expect(createStartResolver(deps({ apiUrl: "http://rsvp.favor.church" }))()).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
