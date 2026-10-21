import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RelayApiClient, RelayNetworkError } from "../../../../vendor/relay/apiClient";
import { assertSafeJobId } from "../../../../vendor/relay/protocol";
import { FileSpool } from "../../../../vendor/relay/spool";

const badIds = ["../outside", "..", ".", "/other", "sub/job", "sub\\job", "id?x=1", "id#fragment", "%2e%2e", "bad job", "", "a".repeat(81), "👶"];
const goodIds = ["job-1", "ABC_02", "550e8400-e29b-41d4-a716-446655440000"];

describe("relay job identity and credential boundaries (#65)", () => {
  it.each(goodIds)("accepts one safe filesystem and URL segment: %s", (id) => {
    expect(assertSafeJobId(id)).toBe(id);
  });

  it.each(badIds)("rejects unsafe job identifiers before an HTTP request: %s", async (id) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "sending" }), { status: 200 }));
    const api = new RelayApiClient({ baseUrl: "https://rsvp.example.test", relayId: "test", token: "secret", fetch });
    expect(() => api.sending(id, "claim")).toThrow("invalid print job id");
    expect(() => api.report(id, "claim", "sent")).toThrow("invalid print job id");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe job ids before any spool write or send marker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "relay-security-"));
    try {
      const spool = new FileSpool(dir);
      await spool.init();
      for (const id of badIds) {
        await expect(spool.get(id)).rejects.toThrow("invalid print job id");
        await expect(spool.claimSend(id)).rejects.toThrow("invalid print job id");
        await expect(spool.remove(id)).rejects.toThrow("invalid print job id");
      }
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forbids redirects on every bearer-token API call", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      const endpoint = String(url);
      const response = endpoint.endsWith("/claim") ? { jobs: [], rejectedPrinterIds: [] }
        : endpoint.endsWith("/heartbeat") ? { ok: true, serverTime: "now", printers: [] }
        : endpoint.endsWith("/config") ? { apiVersion: 1, relayId: "test", label: "test", printerIds: [], printers: [] }
        : endpoint.endsWith("/test-print") ? { apiVersion: 1, testId: "test", printerId: "uuid", zpl: "^XA^XZ" }
        : endpoint.endsWith("/rename") ? { apiVersion: 1, relayId: "test", label: "new" }
        : { status: "sent" };
      return new Response(JSON.stringify(response), { status: 200 });
    });
    const client = new RelayApiClient({ baseUrl: "https://rsvp.example.test", relayId: "test", token: "secret", fetch: fetch as typeof globalThis.fetch });
    await client.claim([], 1);
    await client.heartbeat({ printerIds: [], relayVersion: "1", spoolDepth: 0, probes: [] });
    await client.config();
    await client.testPrint("uuid");
    await client.rename({ label: "new" });
    await client.sending("job-1", "claim");
    await client.report("job-1", "claim", "sent");
    expect(seen).toHaveLength(7);
    for (const { url, init } of seen) {
      expect(url).toMatch(/^https:\/\/rsvp\.example\.test\/api\/printing\/relay\//);
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    }
  });

  it("turns redirect errors into a safe network failure (no follow)", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect !== "error") return new Response(null, { status: 307, headers: { location: "https://other.example.test" } });
      throw new TypeError("redirect disallowed");
    });
    const client = new RelayApiClient({ baseUrl: "https://rsvp.example.test", relayId: "test", token: "secret", fetch: fetch as typeof globalThis.fetch });
    await expect(client.config()).rejects.toBeInstanceOf(RelayNetworkError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
