import { describe, expect, it, vi } from "vitest";

import { RelayApiClient, RelayAuthError, RelayNetworkError } from "../../../../vendor/relay/apiClient";
import {
  cloudStateForError,
  cloudStateForStatus,
  ENROLL_FAILURE_COPY,
  enroll,
  mapEnrollStatus,
  type EnrollFailure,
} from "./cloud";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const request = (fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof enroll>[0]> = {}) => ({
  apiUrl: "https://rsvp.favor.church",
  code: "123456",
  usbSerial: "D2J190800123",
  appVersion: "0.1.0",
  osVersion: "26.0",
  fetch: fetchImpl,
  ...overrides,
});

describe("enroll", () => {
  it("posts the code and returns the credentials", async () => {
    const fetchMock = vi.fn(async () => json(200, { relayId: "relay-1", token: "tok-abc", label: "Lobby laptop" }));
    const outcome = await enroll(request(fetchMock as unknown as typeof fetch, { apiUrl: "https://rsvp.favor.church/" }));

    expect(outcome).toEqual({ ok: true, credentials: { relayId: "relay-1", token: "tok-abc", label: "Lobby laptop" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rsvp.favor.church/api/printing/relay/enroll");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      code: "123456",
      usbSerial: "D2J190800123",
      appVersion: "0.1.0",
      osVersion: "26.0",
    });
  });

  it("allows a missing label", async () => {
    const fetchMock = vi.fn(async () => json(200, { relayId: "relay-1", token: "tok-abc" }));
    const outcome = await enroll(request(fetchMock as unknown as typeof fetch));
    expect(outcome).toMatchObject({ ok: true, credentials: { label: null } });
  });

  it.each<[number, EnrollFailure]>([
    [400, "invalid_request"],
    [422, "invalid_request"],
    [401, "invalid_code"],
    [403, "invalid_code"],
    [404, "invalid_code"],
    [410, "invalid_code"],
    [429, "throttled"],
    [501, "disabled"],
    [500, "unreachable"],
    [502, "unreachable"],
    [503, "unreachable"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    const fetchMock = vi.fn(async () => json(status, {}));
    expect(await enroll(request(fetchMock as unknown as typeof fetch))).toMatchObject({ ok: false, reason, status });
  });

  it("maps an enrollment_disabled error to disabled whatever the status", async () => {
    const fetchMock = vi.fn(async () => json(503, { error: "enrollment_disabled" }));
    expect(await enroll(request(fetchMock as unknown as typeof fetch))).toMatchObject({ ok: false, reason: "disabled", status: 503 });
  });

  it("maps a network failure to unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await enroll(request(fetchMock as unknown as typeof fetch))).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("does not accept a success answer without credentials", async () => {
    for (const body of [{}, { relayId: "r" }, { token: "t" }, { relayId: "", token: "t" }, "text", null]) {
      const fetchMock = vi.fn(async () => json(200, body));
      expect(await enroll(request(fetchMock as unknown as typeof fetch))).toMatchObject({ ok: false, reason: "unreachable" });
    }
  });

  it("does not accept a success answer that is not JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await enroll(request(fetchMock as unknown as typeof fetch))).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it.each(["", "12345", "1234567", "12345a", " 123456"])("rejects the code %j without a request", async (code) => {
    const fetchMock = vi.fn();
    expect(await enroll(request(fetchMock as unknown as typeof fetch, { code }))).toEqual({ ok: false, reason: "invalid_code" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to send a code over plain http to a remote host", async () => {
    const fetchMock = vi.fn();
    const outcome = await enroll(request(fetchMock as unknown as typeof fetch, { apiUrl: "http://rsvp.favor.church" }));
    expect(outcome).toEqual({ ok: false, reason: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows http on loopback", async () => {
    const fetchMock = vi.fn(async () => json(200, { relayId: "r", token: "t" }));
    const outcome = await enroll(request(fetchMock as unknown as typeof fetch, { apiUrl: "http://localhost:3000" }));
    expect(outcome.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:3000/api/printing/relay/enroll");
  });
});

describe("enroll without a usable printer serial", () => {
  it.each([null, "", "has space", "semi;colon", "é-serial", "x".repeat(65)])("refuses %j and never calls fetch", async (usbSerial) => {
    const fetchMock = vi.fn();
    const outcome = await enroll(request(fetchMock as unknown as typeof fetch, { usbSerial }));
    expect(outcome).toEqual({ ok: false, reason: "printer_not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a serial of the shape the server allows", async () => {
    const fetchMock = vi.fn(async () => json(200, { relayId: "r", token: "t" }));
    const outcome = await enroll(request(fetchMock as unknown as typeof fetch, { usbSerial: "A.b_c-9".padEnd(64, "x") }));
    expect(outcome.ok).toBe(true);
  });
});

describe("mapEnrollStatus and copy", () => {
  it("has plain copy for every failure reason", () => {
    const reasons: EnrollFailure[] = ["invalid_code", "throttled", "disabled", "unreachable", "invalid_request", "printer_not_found"];
    for (const reason of reasons) expect(ENROLL_FAILURE_COPY[reason].length).toBeGreaterThan(10);
    expect(Object.keys(ENROLL_FAILURE_COPY).sort()).toEqual([...reasons].sort());
  });

  it("tells an expired code from a throttled one in the copy", () => {
    expect(ENROLL_FAILURE_COPY.invalid_code).toMatch(/expired/i);
    expect(ENROLL_FAILURE_COPY.throttled).toMatch(/wait/i);
    expect(mapEnrollStatus(429)).toBe("throttled");
  });
});

describe("cloud state mapping", () => {
  it("reads 401 as revoked", () => {
    expect(cloudStateForStatus(401)).toBe("revoked");
  });

  it.each([200, 204, 403, 404, 409])("reads %i as the cloud answering", (status) => {
    expect(cloudStateForStatus(status)).toBe("ok");
  });

  it.each([500, 502, 503])("reads %i as unreachable", (status) => {
    expect(cloudStateForStatus(status)).toBe("unreachable");
  });

  it("reads an auth error as revoked and everything else as unreachable", () => {
    expect(cloudStateForError(new RelayAuthError())).toBe("revoked");
    expect(cloudStateForError(new RelayNetworkError("cloud answered 503"))).toBe("unreachable");
    expect(cloudStateForError(new TypeError("fetch failed"))).toBe("unreachable");
    expect(cloudStateForError("boom")).toBe("unreachable");
  });

  it("agrees with the relay API client: a 401 from the cloud is a revocation", async () => {
    const client = new RelayApiClient({
      baseUrl: "https://rsvp.favor.church",
      relayId: "relay-1",
      token: "tok-abc",
      fetch: (async () => new Response(null, { status: 401 })) as typeof fetch,
    });
    const error = await client.config().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(cloudStateForError(error)).toBe("revoked");
  });

  it("agrees with the relay API client: a 503 is unreachable, not revoked", async () => {
    const client = new RelayApiClient({
      baseUrl: "https://rsvp.favor.church",
      relayId: "relay-1",
      token: "tok-abc",
      fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });
    const error = await client.config().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(cloudStateForError(error)).toBe("unreachable");
  });
});
