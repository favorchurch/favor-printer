import { describe, expect, it, vi } from "vitest";

import { readCloudNames, renameInCloud } from "./rename";

const API = "https://rsvp.favor.church";
const CREDENTIALS = { relayId: "relay-1", token: "tok-secret-value" };

function answer(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("readCloudNames", () => {
  it("reads the canonical relay and printer names using the authenticated config endpoint", async () => {
    const printers = [{ id: "printer-1", name: "Front Zebra", usbSerial: "S1" }];
    const fetch = answer(200, { apiVersion: 1, relayId: "relay-1", label: "Lobby desk", printerIds: ["printer-1"], printers });
    await expect(readCloudNames({ apiUrl: API, credentials: CREDENTIALS, fetch })).resolves.toEqual({
      ok: true, label: "Lobby desk", printers,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/printing/relay/config`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-secret-value", "x-relay-id": "relay-1" });
  });

  it.each([[401, "revoked"], [403, "unreachable"], [500, "unreachable"]] as const)(
    "maps config HTTP %i to %s", async (status, reason) => {
      await expect(readCloudNames({ apiUrl: API, credentials: CREDENTIALS, fetch: answer(status) }))
        .resolves.toEqual({ ok: false, reason });
    },
  );

  it("reports network and malformed response failures as unreachable", async () => {
    const networkFailure = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const malformed = vi.fn(async () => new Response("not json", { status: 200 }));
    for (const fetch of [networkFailure, malformed]) {
      await expect(readCloudNames({ apiUrl: API, credentials: CREDENTIALS, fetch }))
        .resolves.toEqual({ ok: false, reason: "unreachable" });
    }
  });

  it("refuses insecure remote HTTP without sending credentials", async () => {
    const fetch = answer(200);
    await expect(readCloudNames({ apiUrl: "http://rsvp.example.test", credentials: CREDENTIALS, fetch }))
      .resolves.toEqual({ ok: false, reason: "unreachable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows local HTTP for development", async () => {
    const fetch = answer(200, { label: "Local", printers: [] });
    await expect(readCloudNames({ apiUrl: "http://localhost:3000", credentials: CREDENTIALS, fetch }))
      .resolves.toEqual({ ok: true, label: "Local", printers: [] });
  });
});

describe("renameInCloud", () => {
  it("posts the laptop label with the relay's credentials", async () => {
    const fetch = answer(200, { apiVersion: 1, relayId: "relay-1", label: "Lobby desk" });
    const outcome = await renameInCloud({ label: "Lobby desk" }, { apiUrl: API, credentials: CREDENTIALS, fetch });

    expect(outcome).toEqual({ ok: true, label: "Lobby desk", printerName: null });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/printing/relay/rename`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-secret-value", "x-relay-id": "relay-1" });
    expect(JSON.parse(String(init.body))).toEqual({ label: "Lobby desk" });
  });

  it("posts the printer id and name, and returns the name the cloud stored", async () => {
    const printerId = "9d1d8a4e-2f0b-4c57-9a0e-3b1f7c2d5e11";
    const fetch = answer(200, {
      apiVersion: 1,
      relayId: "relay-1",
      printer: { id: printerId, name: "Front Zebra", usbSerial: "S1" },
    });
    const outcome = await renameInCloud({ printerId, name: "Front Zebra" }, { apiUrl: API, credentials: CREDENTIALS, fetch });

    expect(outcome).toEqual({ ok: true, label: null, printerName: "Front Zebra" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ printerId, name: "Front Zebra" });
  });

  it.each([
    [409, "name_taken"],
    [400, "invalid_name"],
    [422, "invalid_name"],
    [404, "not_found"],
    [503, "unreachable"],
    [500, "unreachable"],
  ] as const)("maps HTTP %i to %s", async (status, reason) => {
    const outcome = await renameInCloud({ label: "Desk" }, { apiUrl: API, credentials: CREDENTIALS, fetch: answer(status, { error: "x" }) });
    expect(outcome).toEqual({ ok: false, reason });
  });

  it("reports a rejected token as a revocation", async () => {
    const outcome = await renameInCloud({ label: "Desk" }, { apiUrl: API, credentials: CREDENTIALS, fetch: answer(401, { error: "unauthorized" }) });
    expect(outcome).toEqual({ ok: false, reason: "revoked" });
  });

  it("reports a network failure as unreachable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const outcome = await renameInCloud({ label: "Desk" }, { apiUrl: API, credentials: CREDENTIALS, fetch });
    expect(outcome).toEqual({ ok: false, reason: "unreachable" });
  });

  it("refuses a plain http API address without sending anything", async () => {
    const fetch = answer(200, {});
    const outcome = await renameInCloud({ label: "Desk" }, { apiUrl: "http://rsvp.example.test", credentials: CREDENTIALS, fetch });
    expect(outcome).toEqual({ ok: false, reason: "unreachable" });
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("invalid cloud configuration", () => {
  it("treats missing or malformed names as unreachable", async () => {
    for (const body of [{ label: "Desk" }, { label: "Desk", printers: [{}] }, { label: 42, printers: [] }]) {
      const fetcher: typeof fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await expect(readCloudNames({ apiUrl: "https://rsvp.favor.church", credentials: { relayId: "r", token: "t" }, fetch: fetcher })).resolves.toEqual({ ok: false, reason: "unreachable" });
    }
  });
});
