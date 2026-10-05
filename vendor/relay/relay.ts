/**
 * The venue relay: polls the cloud for jobs routed to its printers, spools them
 * on disk, sends them to the printer (TCP 9100, or a CUPS queue for USB; see
 * cups.ts) and reports sent / failed / ambiguous.
 *
 * Safety rules that shape the code:
 *  - Every claimed job is on disk before anything else happens, so a restart
 *    never loses a claim.
 *  - The local stage is advanced to `sending` BEFORE the cloud is told and
 *    before any byte is written. A job found in `sending` after a restart might
 *    have printed, so it is reported ambiguous. It is never sent again.
 *  - An outcome is written to disk before it is delivered, and the entry is
 *    only removed once the cloud has accepted or rejected the report.
 *  - `failed` is reported only when the connection never opened (TCP) or lp
 *    never started (CUPS).
 *  - The ZPL and label live on disk only while a job is `claimed`. They are
 *    dropped the moment the stage moves to `sending`; nothing later needs them.
 *  - Pause and stop never cut a send short. They stop new claims and new
 *    sends, and wait for a send that is already writing.
 */

import {
  RelayAuthError,
  RelayNetworkError,
  type RelayApiClient,
} from "./apiClient";
import type { PrinterTarget, ReportOutcome } from "./protocol";
import type { PrinterTransport, ProbeResult } from "./printer";
import {
  stripPayload,
  type ClaimedEntry,
  type FileSpool,
  type ReportEntry,
  type SpoolEntry,
} from "./spool";

export type RelayLogger = (
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

/**
 * What a relay observer learns. Counts and states only: never a label, ZPL,
 * name or code, so it is safe to forward to a UI or a log.
 */
export type RelaySignal =
  | { kind: "claimed" }
  /** An outcome was recorded for a job (before it reaches the cloud). */
  | { kind: "outcome"; outcome: ReportOutcome }
  | { kind: "inFlight"; value: boolean };

/** Why a test label was not attempted. */
export type TestSendRefusal = "paused" | "busy" | "printer_unavailable";

export type TestSendResult =
  | { kind: "refused"; reason: TestSendRefusal }
  /** `sent` means the transport accepted the bytes (CUPS took the job), not that paper came out. */
  | { kind: "done"; outcome: "sent" | "unsent" | "ambiguous" };

export type HeartbeatIdentity = {
  appVersion?: string;
  osVersion?: string;
  printerAttached?: boolean;
};

export type RelayOptions = {
  api: Pick<RelayApiClient, "claim" | "heartbeat" | "sending" | "report">;
  spool: FileSpool;
  transport: PrinterTransport;
  /**
   * Ids of the printers this relay serves. The cloud still checks ownership.
   * A function is read every cycle, so a list fetched from the cloud can change;
   * while it is empty the relay claims nothing and sends no heartbeat.
   */
  printerIds: string[] | (() => string[]);
  /** Added to every heartbeat. The env-mode relay leaves it out. */
  heartbeatIdentity?: () => HeartbeatIdentity;
  signal?: (signal: RelaySignal) => void;
  version?: string;
  /** Most jobs held locally at once. */
  maxSpool?: number;
  claimLimit?: number;
  pollMs?: number;
  heartbeatMs?: number;
  /** Wait after the cloud rejects the credentials, so a revoked relay does not hammer it. */
  authBackoffMs?: number;
  log?: RelayLogger;
  now?: () => Date;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class Relay {
  private readonly maxSpool: number;
  private readonly claimLimit: number;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly authBackoffMs: number;
  private readonly log: RelayLogger;
  private readonly now: () => Date;

  private chain: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private authBlocked = false;
  private holdsLock = false;

  private paused = false;
  /** A test label is being written; real sends wait for it. */
  private testing = false;
  /** Settles when the test label now being written has left the transport. */
  private testSend: Promise<void> | null = null;
  /** Set by stop() and kept until the next start(): no new claims or sends. */
  private halted = false;
  private startup: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;

  private lastHeartbeatAt = 0;
  private knownPrinters: Array<PrinterTarget & { id: string }> = [];
  /** True once a heartbeat answer has been received by this process. */
  private heartbeatAnswered = false;
  private readonly busy = new Set<string>();
  /** Jobs this process is working right now, from the start of a send to the end of its report. */
  private readonly live = new Set<string>();
  /** Every real send in progress, so stop() can wait for each of them. */
  private readonly activeSends = new Set<Promise<unknown>>();

  constructor(private readonly options: RelayOptions) {
    this.maxSpool = options.maxSpool ?? 20;
    this.claimLimit = options.claimLimit ?? 5;
    this.pollMs = options.pollMs ?? 2_000;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.authBackoffMs = options.authBackoffMs ?? 30_000;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  /** One full cycle. Calls are serialized, so ticks never overlap. */
  tick(): Promise<void> {
    const run = this.chain.then(() => this.runTick());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Throws SpoolLockedError when another relay process already owns the spool. */
  start(): Promise<void> {
    if (this.startup) return this.startup;
    const run = this.begin();
    this.startup = run;
    run.catch(() => {
      if (this.startup === run) this.startup = null;
    });
    return run;
  }

  private async begin() {
    await this.options.spool.acquireLock();
    this.holdsLock = true;
    // stop() arrived while the lock was being taken: do not start a loop.
    if (this.stopping) return;
    // Printer eligibility comes from a heartbeat answer received in this start
    // cycle, never from an earlier one: the cloud may have disabled or removed a
    // printer while the relay was stopped.
    this.forgetPrinters();
    this.stopped = false;
    this.halted = false;
    this.loop = this.runLoop();
  }

  private async runLoop() {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        this.log("error", `cycle failed: ${errorText(error)}`);
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          this.authBlocked ? this.authBackoffMs : this.pollMs,
        );
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** No new claims and no new sends. A send that is already writing finishes. */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.wake?.();
  }

  /** Wake a sleeping poll loop, for example once the printer list has arrived. */
  nudge() {
    this.wake?.();
  }

  get isPaused() {
    return this.paused;
  }

  /**
   * Stop claiming and sending, wait for a send that is already writing, then
   * release the spool. Resolves only once nothing of this relay is in flight.
   * Calling it again while it runs returns the same promise.
   */
  stop(): Promise<void> {
    this.stopping ??= this.halt().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async halt() {
    this.halted = true;
    this.stopped = true;
    this.wake?.();
    await this.startup?.catch(() => undefined);
    await this.loop;
    await this.chain;
    // Never release the spool, or report stopped, while any send is open:
    // every real send, and a test label (written outside the loop and chain).
    while (this.activeSends.size > 0) await Promise.allSettled([...this.activeSends]);
    await this.testSend;
    this.forgetPrinters();
    this.loop = null;
    this.startup = null;
    if (this.holdsLock) {
      this.holdsLock = false;
      await this.options.spool.releaseLock();
    }
  }

  /** Drop everything learned from heartbeat answers, so the next cycle asks again before any send. */
  private forgetPrinters() {
    this.knownPrinters = [];
    this.heartbeatAnswered = false;
    this.lastHeartbeatAt = 0;
  }

  /** Why a test label cannot go out right now, or null. Cheap, so callers can ask before fetching one. */
  testSendBlocker(): "paused" | "busy" | null {
    if (!this.accepting) return "paused";
    if (this.testing || this.busy.size > 0) return "busy";
    return null;
  }

  /**
   * Write a test label to one of this relay's printers. It is not a job: no
   * spool entry, no claim, no `sending` or report call, so a test can never be
   * retried or recorded as a real print. Refused while paused or while any real
   * send is in flight. The ZPL is never logged.
   */
  async sendTestLabel(printerId: string, zpl: string): Promise<TestSendResult> {
    const blocked = this.testSendBlocker();
    if (blocked) return { kind: "refused", reason: blocked };
    // Only an enabled printer this relay is configured for, as the cloud's last
    // heartbeat answer listed it. CUPS ignores the address, but the printer
    // still has to be one of those: a disabled or unknown one gets nothing.
    const target = this.knownPrinters.find((printer) => printer.id === printerId);
    if (!target || !this.canSendTo(printerId)) {
      return { kind: "refused", reason: "printer_unavailable" };
    }

    // Nothing awaits between the check above and these lines, so no real send
    // can start in between.
    this.testing = true;
    this.markBusy(printerId);
    try {
      const sending = this.options.transport.send(target, zpl, {
        // A pause or stop that lands while the connection is opening must win:
        // decline here and the transport writes nothing. A send already past
        // this gate finishes, and stop() waits for it.
        beforeWrite: async () => this.accepting,
      });
      this.testSend = sending.then(
        () => undefined,
        () => undefined,
      );
      const result = await sending;
      // Only our own gate aborts a test label, and only for a pause or stop.
      if (result.kind === "aborted") return { kind: "refused", reason: "paused" };
      const outcome = result.kind;
      this.log(outcome === "sent" ? "info" : "warn", `test label ${outcome}`, { printerId });
      return { kind: "done", outcome };
    } finally {
      this.testing = false;
      this.testSend = null;
      this.markIdle(printerId);
    }
  }

  /**
   * Printers drain in parallel, so `inFlight` follows the set of printers with
   * a send open (real or test), not the last one to finish.
   */
  private markBusy(printerId: string) {
    this.busy.add(printerId);
    this.options.signal?.({ kind: "inFlight", value: true });
  }

  private markIdle(printerId: string) {
    this.busy.delete(printerId);
    this.options.signal?.({ kind: "inFlight", value: this.busy.size > 0 });
  }

  private get accepting() {
    return !this.paused && !this.halted;
  }

  /** Whether a new send may begin: not paused, not stopping, no test label being written. */
  private get mayStartSend() {
    return this.accepting && !this.testing;
  }

  /**
   * Allow-list, not deny-list: a printer is sent to only when it is one of this
   * relay's configured printers AND the cloud's heartbeat answer, received by
   * this process, lists it as enabled. Until that first answer nothing is known,
   * so a claimed entry left in the spool by an earlier run waits untouched; a
   * printer the cloud has since disabled or removed never gets a byte.
   */
  private canSendTo(printerId: string) {
    return (
      this.printerIds.includes(printerId) &&
      this.knownPrinters.some((printer) => printer.id === printerId)
    );
  }

  private mayStartSendTo(printerId: string) {
    return this.mayStartSend && this.canSendTo(printerId);
  }

  private get printerIds() {
    const { printerIds } = this.options;
    return typeof printerIds === "function" ? printerIds() : printerIds;
  }

  private async runTick() {
    this.authBlocked = false;
    // Once the cloud rejects the credentials, every further call this cycle
    // would be rejected too. Stop here and let the backoff run.
    // Learn which printers are enabled before the first send of this process.
    if (!this.heartbeatAnswered && !this.halted) {
      await this.guarded("heartbeat", () => this.heartbeatIfDue());
      if (this.authBlocked) return;
    }
    await this.guarded("drain", () => this.drain());
    if (this.authBlocked) return;
    if (this.accepting) await this.guarded("claim", () => this.claimNew());
    if (this.authBlocked) return;
    await this.guarded("drain", () => this.drain());
    if (this.authBlocked) return;
    if (!this.halted) await this.guarded("heartbeat", () => this.heartbeatIfDue());
  }

  /** One failing stage (cloud down, bad credentials) must not skip the others. */
  private async guarded(stage: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      if (error instanceof RelayAuthError) {
        this.authBlocked = true;
        this.log("error", error.message, { stage });
      } else if (error instanceof RelayNetworkError) {
        this.log("warn", `cloud unreachable: ${error.message}`, { stage });
      } else {
        this.log("error", `unexpected failure: ${errorText(error)}`, { stage });
      }
    }
  }

  private async claimNew() {
    const printerIds = this.printerIds;
    if (printerIds.length === 0) return;
    const held = (await this.options.spool.list()).length;
    const room = this.maxSpool - held;
    if (room <= 0) return;
    // Paused or stopped while the spool was being read: do not ask for work.
    if (!this.accepting) return;

    const { jobs, rejectedPrinterIds } = await this.options.api.claim(
      printerIds,
      Math.min(this.claimLimit, room),
    );
    if (rejectedPrinterIds.length > 0) {
      this.log("warn", "cloud does not assign these printers to this relay", {
        rejectedPrinterIds,
      });
    }
    for (const job of jobs) {
      if (await this.options.spool.addClaimed(job, this.now())) {
        this.options.signal?.({ kind: "claimed" });
      }
      this.log("info", "claimed job", { jobId: job.id, printerId: job.printerId });
    }
  }

  /** Work every spooled entry. Different printers run in parallel, one printer at a time. */
  private async drain() {
    const byPrinter = new Map<string, SpoolEntry[]>();
    for (const entry of await this.options.spool.list()) {
      byPrinter.set(entry.printerId, [...(byPrinter.get(entry.printerId) ?? []), entry]);
    }
    // Settle every printer's task before returning. If one printer's task
    // rejected early (a 401), the others would still be mid-send while the
    // caller went on to recover `sending` entries and let stop() release the lock.
    const settled = await Promise.allSettled(
      [...byPrinter.values()].map(async (entries) => {
        for (const entry of entries) {
          try {
            await this.processEntry(entry);
          } catch (error) {
            if (error instanceof RelayAuthError) throw error;
            this.log("warn", `job ${entry.id} will be retried: ${errorText(error)}`);
          }
        }
      }),
    );
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  private async processEntry(entry: SpoolEntry) {
    // This process is already working the job. Whatever stage the disk shows is
    // its own progress, not a leftover from a dead sender: leave it alone.
    if (this.live.has(entry.id)) return;
    if (entry.stage === "report") return this.deliver(entry);

    if (entry.stage === "sending") {
      // The previous run stopped between opening the connection and recording
      // the result. Bytes may have reached the printer, so never resend.
      return this.recordAndDeliver(
        entry,
        "ambiguous",
        "relay stopped while sending; outcome unknown",
      );
    }
    // A send marker without a `sending` stage means a process took the right
    // to write and died before recording it. Bytes may have gone out.
    const marker = await this.options.spool.sendMarker(entry.id);
    if (marker === "held") return;
    if (marker === "stale") {
      return this.recordAndDeliver(
        entry,
        "ambiguous",
        "relay stopped while starting a send; outcome unknown",
      );
    }
    // Paused or stopping: the entry stays claimed. It prints after resume or a
    // restart, or the cloud refuses its late `sending` and it is dropped.
    // A test label in progress holds the printer for a moment too.
    if (!this.mayStartSendTo(entry.printerId)) return;
    return this.trackSend(entry, () => this.print(entry));
  }

  private async trackSend(entry: ClaimedEntry, run: () => Promise<void>) {
    this.live.add(entry.id);
    const send = run();
    this.activeSends.add(send);
    try {
      await send;
    } finally {
      this.activeSends.delete(send);
      this.live.delete(entry.id);
    }
  }

  private async print(entry: ClaimedEntry) {
    const { spool, api, transport } = this.options;
    this.markBusy(entry.printerId);
    try {
      const result = await transport.send(entry, entry.zpl, {
        beforeWrite: async () => {
          // Paused or stopped while the connection was opening: nothing has
          // been committed, so leave the job claimed and write nothing.
          if (!this.mayStartSendTo(entry.printerId)) return false;
          // Exclusive right to write this job, across processes. The loser
          // writes nothing and leaves the entry to the winner.
          if (!(await spool.claimSend(entry.id))) {
            this.log("warn", "another sender holds this job; skipped", { jobId: entry.id });
            return false;
          }
          // A pause or stop that landed while the marker was being taken wins:
          // give the marker back and leave the entry claimed.
          if (!this.mayStartSend) {
            await spool.releaseSend(entry.id);
            return false;
          }
          // From here the entry no longer needs its payload: `entry.zpl` in
          // memory is what gets written, and a restart reports it ambiguous.
          await spool.write({ ...stripPayload(entry), stage: "sending" });
          // Last check before the cloud is told. If the pause won while the
          // stage was being recorded, put the entry back as it was.
          if (!this.mayStartSend) {
            await spool.write(entry);
            await spool.releaseSend(entry.id);
            return false;
          }
          let answer: Awaited<ReturnType<typeof api.sending>>;
          try {
            answer = await api.sending(entry.id, entry.claimToken);
          } catch (error) {
            // Nothing was written, so the entry is safe to retry later.
            await spool.write(entry);
            await spool.releaseSend(entry.id);
            throw error;
          }
          if (answer.kind !== "ok") {
            // The cloud already gave this job to someone else or expired it.
            await spool.remove(entry.id);
            this.log("warn", "claim no longer valid; dropped before sending", {
              jobId: entry.id,
            });
            return false;
          }
          // A pause or stop that landed while the cloud was answering still
          // wins: write nothing. The cloud already holds the job as `sending`
          // (a `failed` report from there would send it to review), so put the
          // entry back as claimed, exactly as when the answer is lost. Its
          // retried `sending` is accepted again, so it prints once after resume
          // or restart, or is dropped if the lease has run out meanwhile.
          if (!this.mayStartSendTo(entry.printerId)) {
            await spool.write(entry);
            await spool.releaseSend(entry.id);
            return false;
          }
          return true;
        },
      });

      switch (result.kind) {
        case "sent":
          return this.recordAndDeliver(entry, "sent");
        case "unsent":
          return this.recordAndDeliver(entry, "failed", result.error);
        case "ambiguous":
          return this.recordAndDeliver(entry, "ambiguous", result.error);
        case "aborted":
          return;
      }
    } finally {
      this.markIdle(entry.printerId);
    }
  }

  private async recordAndDeliver(
    entry: SpoolEntry,
    outcome: ReportOutcome,
    error?: string,
  ) {
    const recorded: ReportEntry = {
      ...stripPayload(entry),
      stage: "report",
      outcome,
      error,
    };
    await this.options.spool.write(recorded);
    this.options.signal?.({ kind: "outcome", outcome });
    this.log(outcome === "sent" ? "info" : "warn", `job ${outcome}`, {
      jobId: entry.id,
      error,
    });
    await this.deliver(recorded);
  }

  private async deliver(entry: ReportEntry) {
    if (!entry.outcome) return;
    await this.options.api.report(entry.id, entry.claimToken, entry.outcome, entry.error);
    await this.options.spool.remove(entry.id);
  }

  private async probeAll() {
    return Promise.all(
      this.knownPrinters.map(async (printer) => {
        // A printer mid-send is connected by definition; do not open a second socket.
        const { transport } = this.options;
        const result: ProbeResult = this.busy.has(printer.id)
          ? { reachable: true, ...(transport.statusUnknown ? { status: "status_unknown" } : {}) }
          : await transport.probe(printer);
        return {
          printerId: printer.id,
          reachable: result.reachable,
          checkedAt: this.now().toISOString(),
          ...(result.error ? { error: result.error } : {}),
          ...(result.status ? { status: result.status } : {}),
        };
      }),
    );
  }

  private async heartbeatIfDue() {
    const nowMs = this.now().getTime();
    if (this.lastHeartbeatAt && nowMs - this.lastHeartbeatAt < this.heartbeatMs) return;

    const printerIds = this.printerIds;
    if (printerIds.length === 0) return;
    this.lastHeartbeatAt = nowMs;

    const send = async () =>
      this.options.api.heartbeat({
        printerIds,
        relayVersion: this.options.version ?? "dev",
        spoolDepth: (await this.options.spool.list()).length,
        probes: await this.probeAll(),
        ...this.options.heartbeatIdentity?.(),
      });

    let first: Awaited<ReturnType<typeof send>>;
    try {
      first = await send();
    } catch (error) {
      // Nothing is known about the printers yet, so try again next cycle
      // rather than waiting out the heartbeat interval.
      if (!this.heartbeatAnswered) this.lastHeartbeatAt = 0;
      throw error;
    }
    const hadAddresses = this.knownPrinters.length > 0;
    this.knownPrinters = first.printers.filter((p) => p.enabled);
    this.heartbeatAnswered = true;
    // The first beat only learns where the printers are; report reachability now.
    if (!hadAddresses && this.knownPrinters.length > 0) {
      await send();
    }
  }
}
