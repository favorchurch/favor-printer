/**
 * Model the disk-backed print lifecycle through arbitrary claim, send, report,
 * acknowledgement, cancellation and restart sequences. The vendor source is
 * intentionally imported, not modified: RSVP remains the canonical relay.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { FileSpool, type SpoolEntry } from "../../../../vendor/relay/spool";
import type { ClaimedJob, ReportOutcome } from "../../../../vendor/relay/protocol";
import { propertyParams } from "../../shared/testing/property";

type Stage = "empty" | "claimed" | "sending" | "report";
type Model = {
  stage: Stage;
  id: string | null;
  sequence: number;
  outcome: ReportOutcome | null;
  sent: Map<string, number>;
};

type Real = {
  dir: string;
  spool: FileSpool;
};

type Command = fc.AsyncCommand<Model, Real>;

function claimed(id: string): ClaimedJob {
  return {
    id,
    printerId: "9249411d-6e9c-4c72-8129-7e969d07a52a",
    host: "127.0.0.1",
    port: 9100,
    copy: 1,
    label: "Synthetic label (no person data)",
    zpl: "^XA^FO20,20^FDTest^FS^XZ",
    claimToken: "test-claim",
    leaseExpiresAt: "2027-01-01T00:00:00.000Z",
    attempt: 1,
  };
}

function command(name: string, predicate: (model: Model) => boolean, action: (model: Model, real: Real) => Promise<void>): Command {
  return {
    check: predicate,
    async run(model, real) {
      await action(model, real);
      const entries = await real.spool.list();
      expect(entries).toHaveLength(model.stage === "empty" ? 0 : 1);
      if (model.stage !== "empty") {
        const entry = entries[0]!;
        expect(entry.id).toBe(model.id);
        expect(entry.stage).toBe(model.stage);
        if (model.stage !== "claimed") {
          expect(entry).not.toHaveProperty("zpl");
          expect(entry).not.toHaveProperty("label");
        }
        if (model.stage === "report") {
          expect((entry as Extract<SpoolEntry, { stage: "report" }>).outcome).toBe(model.outcome);
        }
      }
      for (const count of model.sent.values()) expect(count).toBeLessThanOrEqual(1);
    },
    toString: () => name,
  };
}

const queue = command("queue a new job", (m) => m.stage === "empty", async (m, r) => {
  m.id = `job-${++m.sequence}`;
  expect(await r.spool.addClaimed(claimed(m.id), new Date("2026-10-19T00:00:00.000Z"))).toBe(true);
  m.stage = "claimed";
  m.outcome = null;
});

const duplicate = command("duplicate claim is refused", (m) => m.stage !== "empty", async (m, r) => {
  expect(await r.spool.addClaimed(claimed(m.id!), new Date())).toBe(false);
});

const send = command("start sending once", (m) => m.stage === "claimed", async (m, r) => {
  expect(await r.spool.claimSend(m.id!)).toBe(true);
  expect(await r.spool.claimSend(m.id!)).toBe(false);
  const entry = (await r.spool.get(m.id!))!;
  expect(entry.stage).toBe("claimed");
  await r.spool.write({ ...entry, stage: "sending" });
  m.sent.set(m.id!, (m.sent.get(m.id!) ?? 0) + 1);
  m.stage = "sending";
});

const report = (outcome: ReportOutcome) => command(`report ${outcome}`, (m) => m.stage === "sending", async (m, r) => {
  const entry = (await r.spool.get(m.id!))!;
  if (entry.stage !== "sending") throw new Error("model and spool disagreed");
  await r.spool.write({ ...entry, stage: "report", outcome });
  m.stage = "report";
  m.outcome = outcome;
});

const failedReport = command("cloud report unavailable", (m) => m.stage === "report", async (m, r) => {
  expect((await r.spool.get(m.id!))?.stage).toBe("report");
  // A network/report failure must retain the outcome, not re-send.
});

const acknowledge = command("cloud acknowledged result", (m) => m.stage === "report", async (m, r) => {
  await r.spool.remove(m.id!);
  m.stage = "empty";
  m.id = null;
  m.outcome = null;
});

const cancelUnsent = command("cancel before any send", (m) => m.stage === "claimed", async (m, r) => {
  await r.spool.remove(m.id!);
  m.stage = "empty";
  m.id = null;
});

const restart = command("restart with durable state", () => true, async (m, r) => {
  r.spool = new FileSpool(r.dir);
  if (m.stage === "sending" || m.stage === "report") {
    expect(await r.spool.sendMarker(m.id!)).not.toBe("none");
  }
  // Restart does not downgrade a sending/ambiguous job to claimed.
});

describe("vendored relay print job lifecycle model (#37)", () => {
  it("never replays sending jobs; retains reports and strips payloads on restart", async () => {
    await fc.assert(fc.asyncProperty(fc.commands([
      fc.constant(queue), fc.constant(duplicate), fc.constant(send),
      fc.constant(report("sent")), fc.constant(report("failed")),
      fc.constant(report("ambiguous")), fc.constant(failedReport),
      fc.constant(acknowledge), fc.constant(cancelUnsent), fc.constant(restart),
    ], { maxCommands: 28 }), async (sequence) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "favor-relay-model-"));
      try {
        await fc.asyncModelRun(() => ({
          model: { stage: "empty" as Stage, id: null, sequence: 0, outcome: null, sent: new Map() },
          real: { dir, spool: new FileSpool(dir) },
        }), sequence);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }), propertyParams(85));
  });
});
