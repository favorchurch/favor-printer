import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { BacklogMonitor, evaluateBacklog } from "./backlog";
import { propertyParams } from "../../shared/testing/property";

describe("evaluateBacklog", () => {
  it("returns null when backlog is empty", () => {
    expect(evaluateBacklog({ queued: 0 })).toBeNull();
  });

  it("returns null when queued jobs are below threshold and draining", () => {
    expect(evaluateBacklog({ queued: 3, threshold: 5, isStuck: false })).toBeNull();
  });

  it("warns when queued jobs exceed threshold", () => {
    const warning = evaluateBacklog({ queued: 5, threshold: 5 });
    expect(warning).toBe("Print backlog is growing: 5 jobs are waiting to print. Check the printer and label stock.");
    expect(warning).not.toContain("—");
  });

  it("warns when queued jobs are stuck", () => {
    const warning = evaluateBacklog({ queued: 2, threshold: 5, isStuck: true });
    expect(warning).toBe(
      "Print backlog is stuck: queued jobs have stopped draining. Check that Favor Printer can reach the printer.",
    );
    expect(warning).toContain("Favor Printer");
    expect(warning).not.toContain("—");
  });

  it("prioritizes threshold warning if queued exceeds threshold even if also stuck", () => {
    const warning = evaluateBacklog({ queued: 8, threshold: 5, isStuck: true });
    expect(warning).toMatch(/backlog is growing/);
  });
});

describe("BacklogMonitor lifecycle and recovery", () => {
  it("handles null counts and resets cleanly", () => {
    const monitor = new BacklogMonitor({ threshold: 2 });
    monitor.update({ claimed: 3, sent: 0, failed: 0, ambiguous: 0 });
    expect(monitor.currentWarning()).not.toBeNull();

    // Null counts does not erase currentWarning
    expect(monitor.update(null)).not.toBeNull();
    expect(monitor.currentWarning()).not.toBeNull();

    // Reset
    monitor.reset();
    expect(monitor.currentWarning()).toBeNull();
  });

  it("handles counter reset (relay restart) and clock skew gracefully", () => {
    let now = 10_000;
    const monitor = new BacklogMonitor({ threshold: 5, stuckTimeoutMs: 30_000, now: () => now });

    // 10 jobs drained previously
    monitor.update({ claimed: 10, sent: 10, failed: 0, ambiguous: 0 });

    // Relay restarts: drained count drops to 0, 1 job claimed
    now = 12_000;
    expect(monitor.update({ claimed: 1, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();

    // Clock steps backwards: currentTime < lastDrainedAt
    now = 5_000;
    expect(monitor.update({ claimed: 1, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();
  });
});

const THRESHOLD = 5;
const STUCK_MS = 30_000;
const STUCK = evaluateBacklog({ queued: 1, threshold: THRESHOLD, isStuck: true });

/**
 * The relay's counters as the monitor sees them, plus the rule a volunteer would state:
 * warn at the threshold, or when a non-empty queue has not drained for STUCK_MS since it
 * last drained or last became non-empty.
 */
type BacklogModel = {
  now: number;
  claimed: number;
  sent: number;
  failed: number;
  ambiguous: number;
  progressAt: number | null;
  lastDrained: number;
  lastQueued: number;
  warning: string | null;
};

type BacklogReal = { monitor: BacklogMonitor; clock: { now: number } };

const drainedOf = (model: BacklogModel) => model.sent + model.failed + model.ambiguous;
const queuedOf = (model: BacklogModel) => model.claimed - drainedOf(model);

function expectedWarning(model: BacklogModel): string | null {
  const drained = drainedOf(model);
  const queued = queuedOf(model);
  if (model.progressAt === null || model.now < model.progressAt || queued === 0 || model.lastQueued === 0 || drained !== model.lastDrained) {
    model.progressAt = model.now;
  }
  model.lastDrained = drained;
  model.lastQueued = queued;
  if (queued >= THRESHOLD) return evaluateBacklog({ queued, threshold: THRESHOLD });
  return queued > 0 && model.now - model.progressAt >= STUCK_MS ? STUCK : null;
}

/** Applies `change` to the counters, polls the monitor, and compares with the model. */
const poll = (name: string, change: (model: BacklogModel) => void, check: (model: BacklogModel) => boolean = () => true) =>
  ({
    check,
    run(model, real) {
      change(model);
      real.clock.now = model.now;
      model.warning = expectedWarning(model);
      const { claimed, sent, failed, ambiguous } = model;
      expect(real.monitor.update({ claimed, sent, failed, ambiguous })).toBe(model.warning);
      expect(real.monitor.currentWarning()).toBe(model.warning);
    },
    toString: () => name,
  }) satisfies fc.Command<BacklogModel, BacklogReal>;

const backlogCommands = [
  fc.integer({ min: 1, max: 4 }).map((n) => poll(`claim ${n}`, (model) => void (model.claimed += n))),
  fc
    .tuple(fc.constantFrom("sent", "failed", "ambiguous" as const), fc.integer({ min: 1, max: 3 }))
    .map(([outcome, n]) =>
      poll(
        `${outcome} ${n}`,
        (model) => void (model[outcome] += Math.min(n, queuedOf(model))),
        (model) => queuedOf(model) > 0,
      ),
    ),
  fc.integer({ min: 1, max: 20_000 }).map((ms) => poll(`wait ${ms}ms`, (model) => void (model.now += ms))),
  // The wall clock can step backwards (NTP, manual change): that restarts the stuck window, never fires it.
  fc.integer({ min: 1, max: 40_000 }).map((ms) => poll(`clock back ${ms}ms`, (model) => void (model.now = Math.max(0, model.now - ms)))),
  fc.integer({ min: 0, max: 3 }).map((claimed) =>
    poll(`relay restart, ${claimed} claimed`, (model) => Object.assign(model, { claimed, sent: 0, failed: 0, ambiguous: 0 })),
  ),
  fc.constant({
    check: () => true,
    run(model: BacklogModel, real: BacklogReal) {
      // No counts (relay not running): the last warning stands.
      expect(real.monitor.update(null)).toBe(model.warning);
    },
    toString: () => "no counts",
  }),
];

describe("BacklogMonitor model", () => {
  it("warns exactly when the backlog is at the threshold or has stopped draining", () => {
    fc.assert(
      fc.property(fc.commands(backlogCommands, { maxCommands: 40 }), (sequence) => {
        const clock = { now: 0 };
        fc.modelRun(
          () => ({
            model: { now: 0, claimed: 0, sent: 0, failed: 0, ambiguous: 0, progressAt: null, lastDrained: 0, lastQueued: 0, warning: null },
            real: { clock, monitor: new BacklogMonitor({ threshold: THRESHOLD, stuckTimeoutMs: STUCK_MS, now: () => clock.now }) },
          }),
          sequence,
        );
      }),
      propertyParams(),
    );
  });
});

/** Anchor cases stated without the model, so the model and the monitor cannot share a misreading. */
describe("BacklogMonitor anchors", () => {
  const counts = (claimed: number, sent = 0) => ({ claimed, sent, failed: 0, ambiguous: 0 });

  it("warns stuck when a short queue has not drained for longer than the window", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: THRESHOLD - 1 }), fc.integer({ min: STUCK_MS, max: 10 * STUCK_MS }), (queued, wait) => {
        let now = 0;
        const monitor = new BacklogMonitor({ threshold: THRESHOLD, stuckTimeoutMs: STUCK_MS, now: () => now });
        expect(monitor.update(counts(queued))).toBeNull();
        now = wait;
        expect(monitor.update(counts(queued))).toBe(STUCK);
      }),
      propertyParams(),
    );
  });

  it("never warns while a short queue drains at least once per window", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: STUCK_MS - 1 }), { minLength: 1, maxLength: 20 }), (gaps) => {
        let now = 0;
        const monitor = new BacklogMonitor({ threshold: THRESHOLD, stuckTimeoutMs: STUCK_MS, now: () => now });
        const claimed = gaps.length + 1;
        expect(monitor.update(counts(Math.min(claimed, THRESHOLD - 1)))).toBeNull();
        gaps.forEach((gap, sent) => {
          now += gap;
          const queuedClaim = Math.min(claimed, sent + THRESHOLD - 1);
          expect(monitor.update(counts(queuedClaim, sent + 1))).toBeNull();
        });
      }),
      propertyParams(),
    );
  });

  it("measures the stuck window from the stepped-back time after the clock goes backwards", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 * STUCK_MS }), fc.integer({ min: 1, max: 10 * STUCK_MS }), (start, back) => {
        let now = start + back;
        const monitor = new BacklogMonitor({ threshold: THRESHOLD, stuckTimeoutMs: STUCK_MS, now: () => now });
        expect(monitor.update(counts(1))).toBeNull();
        now = start;
        expect(monitor.update(counts(1))).toBeNull();
        now = start + STUCK_MS;
        expect(monitor.update(counts(1))).toBe(STUCK);
      }),
      propertyParams(),
    );
  });

  it("warns growing whenever the queue reaches the threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: THRESHOLD, max: 100 }), (queued) => {
        expect(new BacklogMonitor({ threshold: THRESHOLD }).update(counts(queued))).toMatch(/backlog is growing/);
      }),
      propertyParams(),
    );
  });
});
