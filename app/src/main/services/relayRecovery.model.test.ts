/**
 * Exercise the relay actually shipped by Favor Printer. RSVP remains the
 * canonical source; these tests intentionally live outside vendor/ so a sync
 * preserves the app's recovery contract without modifying the vendored code.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { RelayNetworkError } from "../../../../vendor/relay/apiClient";
import type { ClaimedJob, ReportOutcome } from "../../../../vendor/relay/protocol";
import { Relay } from "../../../../vendor/relay/relay";
import { FileSpool } from "../../../../vendor/relay/spool";
import { propertyParams } from "../../shared/testing/property";

const printerId = "9249411d-6e9c-4c72-8129-7e969d07a52a";
const now = () => new Date("2026-10-20T00:00:00.000Z");
type TransportMode = "sent" | "unsent" | "ambiguous" | "crash-after-write";
type Delivered = { id: string; attempt: number; outcome: ReportOutcome };

/** Only the cloud and printer boundaries are synthetic; every tick uses Relay and FileSpool. */
class Harness {
  spool: FileSpool;
  relay: Relay;
  transportMode: TransportMode = "sent";
  sendingOnline = true;
  reportOnline = true;
  job: { value: ClaimedJob; state: "queued" | "claimed" | "reported" | "cancelled" } | null = null;
  readonly bytes: Array<{ id: string; attempt: number }> = [];
  readonly accepted: Delivered[] = [];
  readonly reportAttempts: Delivered[] = [];
  readonly sendingAttempts: string[] = [];
  private readonly payloads = new Map<string, { id: string; attempt: number }>();

  constructor(readonly dir: string) {
    this.spool = new FileSpool(dir);
    this.relay = this.createRelay();
  }

  queue(id: string, attempt = 1) {
    const zpl = `^XA^FDsynthetic-${id}-${attempt}^FS^XZ`;
    this.payloads.set(zpl, { id, attempt });
    this.job = {
      state: "queued",
      value: {
        id, attempt, printerId, host: "127.0.0.1", port: 9100, copy: 1,
        label: "Synthetic test label", zpl, claimToken: `synthetic-${id}-${attempt}`,
        leaseExpiresAt: "2027-01-01T00:00:00.000Z",
      },
    };
  }

  cancel() {
    if (!this.job) throw new Error("no synthetic job to cancel");
    this.job.state = "cancelled";
  }

  async restart() {
    await this.relay.stop();
    this.spool = new FileSpool(this.dir);
    this.relay = this.createRelay();
  }

  private current(id: string, token: string) {
    const job = this.job;
    return job?.value.id === id && job.value.claimToken === token && job.state !== "cancelled" ? job : null;
  }

  private createRelay() {
    return new Relay({
      spool: this.spool, printerIds: [printerId], now,
      api: {
        claim: async () => {
          if (this.job?.state !== "queued") return { jobs: [], rejectedPrinterIds: [] };
          this.job.state = "claimed";
          return { jobs: [{ ...this.job.value }], rejectedPrinterIds: [] };
        },
        heartbeat: async () => ({
          ok: true, serverTime: now().toISOString(),
          printers: [{ id: printerId, name: "Synthetic printer", host: "127.0.0.1", port: 9100, enabled: true }],
        }),
        sending: async (id, token) => {
          this.sendingAttempts.push(id);
          if (!this.sendingOnline) throw new RelayNetworkError("synthetic sending outage");
          return this.current(id, token) ? { kind: "ok", status: "sending" } : { kind: "stale" };
        },
        report: async (id, token, outcome) => {
          const job = this.current(id, token);
          if (!job) return { kind: "stale" };
          const delivered = { id, attempt: job.value.attempt, outcome };
          this.reportAttempts.push(delivered);
          if (!this.reportOnline) throw new RelayNetworkError("synthetic report outage");
          this.accepted.push(delivered);
          job.state = "reported";
          return { kind: "ok", status: outcome };
        },
      },
      transport: {
        probe: async () => ({ reachable: true }),
        send: async (_target, zpl, hooks) => {
          // A failed connection has not crossed the write gate or emitted any bytes.
          if (this.transportMode === "unsent") return { kind: "unsent", error: "synthetic connect failure" };
          if (!(await hooks.beforeWrite())) return { kind: "aborted" };
          const payload = this.payloads.get(zpl);
          if (!payload) throw new Error("unexpected printer payload");
          this.bytes.push(payload);
          // Leave the real durable sending stage without recording an outcome.
          if (this.transportMode === "crash-after-write") throw new Error("synthetic crash boundary after bytes");
          return this.transportMode === "ambiguous"
            ? { kind: "ambiguous", error: "synthetic unconfirmed flush" }
            : { kind: "sent" };
        },
      },
    });
  }
}

async function withHarness(run: (real: Harness) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "favor-relay-recovery-"));
  const real = new Harness(dir);
  try {
    await run(real);
  } finally {
    await real.relay.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

type Model = {
  sequence: number;
  id: string | null;
  attempt: number;
  phase: "empty" | "ready" | "report" | "done" | "cancelled";
  held: boolean;
  outcome: ReportOutcome | null;
  transportMode: Exclude<TransportMode, "crash-after-write">;
  sendingOnline: boolean;
  reportOnline: boolean;
  writes: Map<string, number>;
  accepted: Delivered[];
};

const initialModel = (): Model => ({
  sequence: 0, id: null, attempt: 0, phase: "empty", held: false, outcome: null,
  transportMode: "sent", sendingOnline: true, reportOnline: true,
  writes: new Map(), accepted: [],
});

/** The outcome oracle counts bytes at the transport boundary, independently of spool stages. */
async function assertOutcomes(model: Model, real: Harness) {
  for (const [id, expected] of model.writes) {
    expect(real.bytes.filter((write) => write.id === id)).toHaveLength(expected);
    expect(expected).toBeLessThanOrEqual(1);
  }
  expect(real.bytes.every((write) => model.writes.has(write.id))).toBe(true);
  expect(real.accepted).toEqual(model.accepted);
  const entries = await real.spool.list();
  const pending = model.phase === "report" || (model.phase === "ready" && model.held);
  expect(entries).toHaveLength(pending ? 1 : 0);
  if (pending) {
    const entry = entries[0]!;
    expect(entry.id).toBe(model.id);
    expect(entry.attempt).toBe(model.attempt);
    expect(entry.stage).toBe(model.phase === "report" ? "report" : "claimed");
    if (entry.stage === "report") {
      expect(entry.outcome).toBe(model.outcome);
      expect(entry).not.toHaveProperty("zpl");
      expect(entry).not.toHaveProperty("label");
    }
  }
}

/** Predict public outcomes, without invoking or inspecting the relay to decide them. */
function advance(model: Model) {
  if (model.phase === "ready") {
    model.held = true;
    if (model.transportMode !== "unsent" && !model.sendingOnline) return;
    model.outcome = model.transportMode === "unsent" ? "failed" : model.transportMode;
    if (model.transportMode !== "unsent") model.writes.set(model.id!, model.writes.get(model.id!)! + 1);
    model.phase = "report";
  }
  if (model.phase === "report" && model.reportOnline) {
    model.accepted.push({ id: model.id!, attempt: model.attempt, outcome: model.outcome! });
    model.phase = "done";
  }
}

function command(
  name: string,
  action: (model: Model, real: Harness) => Promise<void> | void,
  check: (model: Model) => boolean = () => true,
): fc.AsyncCommand<Model, Harness> {
  return {
    check,
    async run(model, real) {
      await action(model, real);
      await assertOutcomes(model, real);
    },
    toString: () => name,
  };
}

const queue = command("queue", (m, r) => {
  m.id = `job-${++m.sequence}`;
  m.attempt = 1;
  m.phase = "ready";
  m.held = false;
  m.outcome = null;
  m.writes.set(m.id, 0);
  r.queue(m.id);
}, (m) => ["empty", "done", "cancelled"].includes(m.phase));

// Ticks and restarts are always legal, including after a job has printed.
const tick = command("tick", async (m, r) => { advance(m); await r.relay.tick(); });
const restart = command("restart then tick", async (m, r) => {
  advance(m);
  await r.restart();
  await r.relay.tick();
});
const retry = command("retry definitely unsent job", (m, r) => {
  m.attempt++;
  m.phase = "ready";
  m.held = false;
  m.outcome = null;
  r.queue(m.id!, m.attempt);
}, (m) => m.phase === "done" && m.outcome === "failed");
const cancel = command("cancel unsent job with reachable cloud", async (m, r) => {
  r.cancel();
  m.sendingOnline = r.sendingOnline = true;
  m.transportMode = r.transportMode = "sent";
  m.phase = "cancelled";
  await r.relay.tick();
}, (m) => m.phase === "ready");
const reportAvailability = fc.boolean().map((online) => command(`report online=${online}`, (m, r) => {
  m.reportOnline = r.reportOnline = online;
}));
const sendingAvailability = fc.boolean().map((online) => command(`sending online=${online}`, (m, r) => {
  m.sendingOnline = r.sendingOnline = online;
}));
const transportOutcome = fc.constantFrom("sent" as const, "unsent" as const, "ambiguous" as const)
  .map((mode) => command(`transport ${mode}`, (m, r) => { m.transportMode = r.transportMode = mode; }));

describe("real vendored relay recovery model (#37)", () => {
  it("retains a sent report through outages and restart without sending the bytes again", async () => {
    await withHarness(async (r) => {
      r.queue("printed");
      r.reportOnline = false;
      await r.relay.tick();
      expect(r.bytes).toEqual([{ id: "printed", attempt: 1 }]);
      expect(await r.spool.get("printed")).toMatchObject({ stage: "report", outcome: "sent" });
      const attempts = r.reportAttempts.length;
      await r.restart();
      await r.relay.tick();
      expect(r.reportAttempts.length).toBeGreaterThan(attempts);
      expect(r.accepted).toEqual([]);
      expect(r.bytes).toHaveLength(1);
      r.reportOnline = true;
      await r.restart();
      await r.relay.tick();
      await r.relay.tick();
      expect(r.accepted).toEqual([{ id: "printed", attempt: 1, outcome: "sent" }]);
      expect(r.bytes).toHaveLength(1);
      expect(await r.spool.list()).toEqual([]);
    });
  });

  it("recovers the durable sending stage as ambiguous after a crash boundary, never resending", async () => {
    await withHarness(async (r) => {
      r.queue("interrupted");
      r.transportMode = "crash-after-write";
      await r.relay.tick();
      const sending = await r.spool.get("interrupted");
      expect(sending?.stage).toBe("sending");
      expect(sending).not.toHaveProperty("zpl");
      expect(sending).not.toHaveProperty("label");
      r.transportMode = "sent";
      r.reportOnline = false;
      await r.restart();
      await r.relay.tick();
      expect(await r.spool.get("interrupted")).toMatchObject({ stage: "report", outcome: "ambiguous" });
      r.reportOnline = true;
      await r.restart();
      await r.relay.tick();
      expect(r.bytes).toEqual([{ id: "interrupted", attempt: 1 }]);
      expect(r.accepted).toEqual([{ id: "interrupted", attempt: 1, outcome: "ambiguous" }]);
      expect(await r.spool.list()).toEqual([]);
    });
  });

  it("allows a new cloud attempt after a definitely unsent failure and prints it once", async () => {
    await withHarness(async (r) => {
      r.queue("retry");
      r.transportMode = "unsent";
      await r.relay.tick();
      expect(r.bytes).toEqual([]);
      expect(r.accepted).toEqual([{ id: "retry", attempt: 1, outcome: "failed" }]);
      r.queue("retry", 2);
      r.transportMode = "sent";
      await r.restart();
      await r.relay.tick();
      await r.restart();
      await r.relay.tick();
      expect(r.bytes).toEqual([{ id: "retry", attempt: 2 }]);
      expect(r.accepted).toEqual([
        { id: "retry", attempt: 1, outcome: "failed" },
        { id: "retry", attempt: 2, outcome: "sent" },
      ]);
    });
  });

  it("drops a cancelled claimed job when sending is rejected before any printer bytes", async () => {
    await withHarness(async (r) => {
      r.queue("cancel");
      r.sendingOnline = false;
      await r.relay.tick();
      expect((await r.spool.get("cancel"))?.stage).toBe("claimed");
      r.cancel();
      r.sendingOnline = true;
      const attempts = r.sendingAttempts.length;
      await r.restart();
      await r.relay.tick();
      expect(r.sendingAttempts.length).toBeGreaterThan(attempts);
      expect(r.bytes).toEqual([]);
      expect(r.accepted).toEqual([]);
      expect(await r.spool.list()).toEqual([]);
    });
  });

  it("matches byte and delivery outcomes across arbitrary retry, cancel, fault and restart commands", async () => {
    await fc.assert(fc.asyncProperty(fc.commands([
      fc.constant(queue), fc.constant(queue), fc.constant(tick), fc.constant(tick),
      fc.constant(restart), fc.constant(retry), fc.constant(cancel),
      reportAvailability, sendingAvailability, transportOutcome,
    ], { maxCommands: 35 }), async (commands) => {
      await withHarness(async (real) => {
        await fc.asyncModelRun(() => ({ model: initialModel(), real }), commands);
      });
    }), propertyParams(85));
  }, 20_000);
});
