/**
 * In-process cloud API server running against the RSVP checkout's real
 * relayApi handlers and test harness. Started by scripts/e2e-relay-sim.mjs
 * via tsx inside RSVP_DIR.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { handleRelayRequest } from "@/lib/printing/relayApi";
import { createRelayTestHarness, RELAY_TOKENS } from "@/lib/printing/relayTestHarness";

async function main() {
  const h = createRelayTestHarness();

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const url = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);

    // HTTP Control endpoints for easy query without IPC dependency
    if (url.pathname === "/_control/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, tokens: RELAY_TOKENS }));
      return;
    }

    if (url.pathname === "/_control/pointPrinter" && req.method === "POST") {
      const data = body ? JSON.parse(body.toString("utf8")) : {};
      h.pointPrinter(data.printerId ?? "p1", Number(data.port));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/_control/enqueue" && req.method === "POST") {
      const data = body ? JSON.parse(body.toString("utf8")) : {};
      const job = await h.enqueue(
        data.stationId ?? "s1",
        data.actionId ?? `act-${Date.now()}`,
        data.zpl ?? "^XA^FO20,20^FDE2E Test^FS^XZ",
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, job }));
      return;
    }

    if (url.pathname.startsWith("/_control/job/") && req.method === "GET") {
      const jobId = url.pathname.slice("/_control/job/".length);
      const job = await h.store.getJob(jobId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, job }));
      return;
    }

    // Relay API endpoints
    const request = new Request(url.href, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
    });

    const response = await handleRelayRequest(request, h.deps);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  // IPC channel support
  process.on("message", async (msg: unknown) => {
    try {
      if (!msg || typeof msg !== "object") return;
      const data = msg as Record<string, unknown>;
      if (data.type === "pointPrinter") {
        h.pointPrinter(String(data.printerId ?? "p1"), Number(data.port));
        process.send?.({ type: "pointPrinterOk" });
      } else if (data.type === "enqueue") {
        const job = await h.enqueue(
          String(data.stationId ?? "s1"),
          String(data.actionId ?? `act-${Date.now()}`),
          String(data.zpl ?? "^XA^FO20,20^FDE2E Test^FS^XZ"),
        );
        process.send?.({ type: "enqueueOk", job });
      } else if (data.type === "getJob") {
        const job = await h.store.getJob(String(data.jobId));
        process.send?.({ type: "getJobOk", job });
      } else if (data.type === "stop") {
        server.close(() => {
          process.send?.({ type: "stopped" });
          process.exit(0);
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.send?.({ type: "error", error: message });
    }
  });

  process.send?.({
    type: "ready",
    port,
    tokens: RELAY_TOKENS,
  });

  // Also print a ready marker to stdout so parent can read the port if not using IPC
  console.log(`[harness-server] listening on port ${port}`);
}

main().catch((err) => {
  console.error("[harness-server] fatal error:", err);
  process.exit(1);
});
