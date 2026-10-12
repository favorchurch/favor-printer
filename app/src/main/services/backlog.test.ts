import { describe, expect, it } from "vitest";

import { BacklogMonitor, evaluateBacklog } from "./backlog";

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
  it("tracks jobs and warns when threshold is exceeded, then clears on recovery", () => {
    const now = 1000;
    const monitor = new BacklogMonitor({ threshold: 4, now: () => now });

    // Initial: 0 jobs
    expect(monitor.update({ claimed: 0, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();

    // 2 jobs claimed, none finished: below threshold, not stuck
    expect(monitor.update({ claimed: 2, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();

    // 4 jobs claimed: reaches threshold -> warning!
    const warn = monitor.update({ claimed: 4, sent: 0, failed: 0, ambiguous: 0 });
    expect(warn).toContain("Print backlog is growing: 4 jobs are waiting to print.");

    // Still 4 jobs: warning persists
    expect(monitor.currentWarning()).toBe(warn);

    // Jobs drain: 2 sent, 1 failed, 1 ambiguous -> total drained = 4 -> queued = 0 -> warning clears!
    const recovered = monitor.update({ claimed: 4, sent: 2, failed: 1, ambiguous: 1 });
    expect(recovered).toBeNull();
    expect(monitor.currentWarning()).toBeNull();
  });

  it("warns when jobs stop draining past stuckTimeoutMs, and clears when draining resumes", () => {
    let now = 10_000;
    const monitor = new BacklogMonitor({ threshold: 5, stuckTimeoutMs: 30_000, now: () => now });

    // 2 jobs queued at t=10_000
    expect(monitor.update({ claimed: 2, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();

    // t=30_000 (20s elapsed): still not stuck
    now = 30_000;
    expect(monitor.update({ claimed: 2, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();

    // t=45_000 (35s elapsed > 30s timeout): jobs stopped draining -> stuck warning!
    now = 45_000;
    const stuckWarn = monitor.update({ claimed: 2, sent: 0, failed: 0, ambiguous: 0 });
    expect(stuckWarn).toBe(
      "Print backlog is stuck: queued jobs have stopped draining. Check that Favor Printer can reach the printer.",
    );

    // Job finishes draining at t=46_000: sent goes to 1 -> lastDrainedAt resets, queued = 1 < 5
    now = 46_000;
    const drainingResume = monitor.update({ claimed: 2, sent: 1, failed: 0, ambiguous: 0 });
    expect(drainingResume).toBeNull();

    // Final job finishes -> queued = 0
    now = 50_000;
    expect(monitor.update({ claimed: 2, sent: 2, failed: 0, ambiguous: 0 })).toBeNull();
  });

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

  it("resets stuck timer when idle so first job after idle period does not falsely warn", () => {
    let now = 0;
    const monitor = new BacklogMonitor({ threshold: 5, stuckTimeoutMs: 30_000, now: () => now });

    // Update with no jobs at t=0
    expect(monitor.update({ claimed: 0, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();

    // At t=60_000, update with claimed 1 and sent 0 -> expect null (not immediately stuck)
    now = 60_000;
    expect(monitor.update({ claimed: 1, sent: 0, failed: 0, ambiguous: 0 })).toBeNull();

    // At t=95_000, 35s have elapsed with no drain -> expect stuck copy
    now = 95_000;
    expect(monitor.update({ claimed: 1, sent: 0, failed: 0, ambiguous: 0 })).toBe(
      "Print backlog is stuck: queued jobs have stopped draining. Check that Favor Printer can reach the printer.",
    );
  });
});
