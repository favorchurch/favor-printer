/**
 * Backlog warning detection for Favor Printer.
 *
 * Warns when queued relay jobs exceed a threshold or stop draining,
 * and clears the warning upon recovery.
 */

export const DEFAULT_BACKLOG_THRESHOLD = 5;
export const DEFAULT_STUCK_TIMEOUT_MS = 30_000;

export type BacklogCounts = {
  claimed: number;
  sent: number;
  failed: number;
  ambiguous: number;
};

export type BacklogEvaluation = {
  warning: string | null;
  queued: number;
  isStuck: boolean;
  isThresholdExceeded: boolean;
};

export function evaluateBacklog(input: {
  queued: number;
  threshold?: number;
  isStuck?: boolean;
}): string | null {
  const threshold = input.threshold ?? DEFAULT_BACKLOG_THRESHOLD;
  if (input.queued >= threshold) {
    return `Print backlog is growing: ${input.queued} jobs are waiting to print. Check the printer and label stock.`;
  }
  if (input.queued > 0 && input.isStuck) {
    return "Print backlog is stuck: queued jobs have stopped draining. Check that Favor Printer can reach the printer.";
  }
  return null;
}

export class BacklogMonitor {
  private lastDrainedCount = 0;
  private lastQueuedCount = 0;
  private lastDrainedAt: number | null = null;
  private lastWarning: string | null = null;
  private readonly threshold: number;
  private readonly stuckTimeoutMs: number;
  private readonly now: () => number;

  constructor(options?: {
    threshold?: number;
    stuckTimeoutMs?: number;
    now?: () => number;
  }) {
    this.threshold = options?.threshold ?? DEFAULT_BACKLOG_THRESHOLD;
    this.stuckTimeoutMs = options?.stuckTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;
    this.now = options?.now ?? (() => Date.now());
  }

  update(counts: BacklogCounts | null): string | null {
    if (!counts) {
      return this.lastWarning;
    }

    const drained = counts.sent + counts.failed + counts.ambiguous;
    const queued = Math.max(0, counts.claimed - drained);
    const currentTime = this.now();

    if (
      this.lastDrainedAt === null ||
      queued === 0 ||
      this.lastQueuedCount === 0 ||
      drained < this.lastDrainedCount ||
      currentTime < (this.lastDrainedAt ?? currentTime)
    ) {
      this.lastDrainedAt = currentTime;
      this.lastDrainedCount = drained;
    } else if (drained > this.lastDrainedCount) {
      this.lastDrainedCount = drained;
      this.lastDrainedAt = currentTime;
    }
    this.lastQueuedCount = queued;

    const elapsed = Math.max(0, currentTime - (this.lastDrainedAt ?? currentTime));
    const isStuck = queued > 0 && elapsed >= this.stuckTimeoutMs;

    this.lastWarning = evaluateBacklog({
      queued,
      threshold: this.threshold,
      isStuck,
    });

    return this.lastWarning;
  }

  currentWarning(): string | null {
    return this.lastWarning;
  }

  reset(): void {
    this.lastDrainedCount = 0;
    this.lastQueuedCount = 0;
    this.lastDrainedAt = null;
    this.lastWarning = null;
  }
}
