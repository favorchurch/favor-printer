/**
 * Runs the vendored relay (`dist/relay.js`) as a child and keeps it running.
 * The child is injected (`RelayForker`), so tests drive it with a fake and
 * production passes Electron's `utilityProcess.fork`.
 *
 * - It starts only when `resolveStart` says so: not while the legacy agent is
 *   loaded, not before enrollment, not after a revocation.
 * - A child that exits without being asked is restarted with a growing delay.
 *   The restart is visible in `state()` so the tray can say so.
 * - `stop` sends `{type:"stop"}` and waits for `{type:"stopped"}`. The wait is
 *   bounded, and a child that is still sending is never killed: past the
 *   ceiling it is left to finish.
 */

import type { EmbeddedStartOptions } from "../../../../vendor/relay/embeddedProtocol";
import type { TestPrintResult } from "../../../../vendor/relay/index";
import type { RelayErrorCode, RelayState, RelayStatus, CloudState } from "../../../../vendor/relay/status";
import { systemTimers, type Timers } from "../services";
import type { Logger } from "./log";

/** The slice of Electron's `UtilityProcess` the supervisor uses. */
export type RelayChild = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): boolean;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
};

export type RelayForker = () => RelayChild;

export type BlockReason = "legacy_loaded" | "not_enrolled" | "revoked" | "no_queue" | "unavailable";

export type StartResolution = { ok: true; options: EmbeddedStartOptions } | { ok: false; reason: BlockReason };

export type SupervisorPhase = "idle" | "starting" | "running" | "restarting" | "stopping" | "blocked";

export type SupervisorState = {
  phase: SupervisorPhase;
  blockedReason: BlockReason | null;
  /** Unrequested exits since `start`. */
  restarts: number;
  lastExitCode: number | null;
  /** The last `{type:"error"}` code the child reported. */
  lastErrorCode: string | null;
  relay: RelayStatus | null;
};

export type StopOutcome = "not_running" | "stopped" | "killed" | "abandoned";

export type TestPrintReply = {
  ok: boolean;
  transportOutcome?: "sent" | "unsent" | "ambiguous";
  error?: string;
};

export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000] as const;

export function restartDelay(attempt: number): number {
  return RESTART_DELAYS_MS[Math.min(Math.max(attempt, 0), RESTART_DELAYS_MS.length - 1)];
}

export type SupervisorTuning = {
  /** A child that ran this long before exiting resets the backoff. */
  healthyAfterMs: number;
  /** How long `stop` waits before it considers killing. */
  stopWaitMs: number;
  /** Total wait while the child is still sending. Past this it is abandoned, never killed. */
  inFlightCeilingMs: number;
  testPrintTimeoutMs: number;
};

export const DEFAULT_TUNING: SupervisorTuning = {
  healthyAfterMs: 60_000,
  stopWaitMs: 10_000,
  inFlightCeilingMs: 60_000,
  testPrintTimeoutMs: 45_000,
};

export type RelaySupervisor = {
  /** Starts the relay when allowed. Safe to call again: a running relay is left alone. */
  start(): Promise<void>;
  stop(): Promise<StopOutcome>;
  /** Stop, then start again with fresh options (new credentials, new queue). */
  restart(): Promise<void>;
  pause(): void;
  resume(): void;
  testPrint(printerId: string): Promise<TestPrintReply>;
  /** Forwarded to the child as `{type:"printerAttached", attached}` and kept for the next start. */
  setPrinterAttached(attached: boolean): void;
  state(): SupervisorState;
  /** The child's last status said a send is writing. */
  jobInFlight(): boolean;
  /**
   * Resolves once there is no child: it posted `stopped` or exited. Immediately when none runs.
   * Quit waits on this after `stop` gave up on a send that was still writing.
   */
  settled(): Promise<void>;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * What crosses from the relay child into the app is rebuilt field by field. The child is trusted to
 * keep names, label content and security codes out of its messages, and this makes that a property of
 * the app too: a field it did not expect, or text where a code or a count belongs, is dropped here,
 * before anything is shown, stored or logged.
 */
const RELAY_STATES: Record<RelayState, true> = { starting: true, running: true, paused: true, stopping: true, stopped: true };
const CLOUD_STATES: Record<CloudState, true> = { ok: true, unreachable: true, revoked: true };
const ERROR_CODES: Record<RelayErrorCode, true> = {
  cloud_unreachable: true,
  credentials_rejected: true,
  config_unavailable: true,
  config_invalid: true,
  spool_locked: true,
  invalid_options: true,
  send_failed: true,
  send_ambiguous: true,
  unexpected: true,
};
/**
 * Why the relay did not attempt a test label, keyed on the vendored relay's own type: a refusal added
 * by a re-vendor fails the typecheck here until it is listed (and mapped in the controller), instead
 * of being sanitized to `unexpected`.
 */
type TestPrintRefusal = Exclude<NonNullable<TestPrintResult["error"]>, RelayErrorCode>;
const TEST_PRINT_REFUSALS: Record<TestPrintRefusal, true> = {
  unknown_printer: true,
  paused: true,
  busy: true,
  printer_unavailable: true,
};
const TRANSPORT_OUTCOMES = new Set<string>(["sent", "unsent", "ambiguous"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]{8,16}Z$/;
const PRINTER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const has = <T extends string>(table: Record<T, true>, value: unknown): value is T =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const isoOrNull = (value: unknown): string | null => (typeof value === "string" && ISO_TIME.test(value) ? value : null);

/** A clean copy of a relay status event, or null when it is not one. */
export function sanitizeRelayStatus(raw: unknown): RelayStatus | null {
  if (!isObject(raw) || !has(RELAY_STATES, raw.state) || !has(CLOUD_STATES, raw.cloud)) return null;
  const counts = isObject(raw.counts) ? raw.counts : {};
  return {
    state: raw.state,
    cloud: raw.cloud,
    printerIds: Array.isArray(raw.printerIds)
      ? raw.printerIds.filter((id): id is string => typeof id === "string" && PRINTER_ID.test(id))
      : [],
    inFlight: raw.inFlight === true,
    counts: { claimed: count(counts.claimed), sent: count(counts.sent), failed: count(counts.failed), ambiguous: count(counts.ambiguous) },
    lastJobAt: isoOrNull(raw.lastJobAt),
    lastHeartbeatAt: isoOrNull(raw.lastHeartbeatAt),
    lastError: has(ERROR_CODES, raw.lastError) ? raw.lastError : null,
  };
}

/** A relay error code, or `unexpected` for anything that is not one of the fixed set. */
export function sanitizeErrorCode(raw: unknown): RelayErrorCode | "bad_message" {
  if (raw === "bad_message") return raw;
  return has(ERROR_CODES, raw) ? raw : "unexpected";
}

export function sanitizeTestPrintReply(message: Record<string, unknown>): TestPrintReply {
  const reply: TestPrintReply = { ok: message.ok === true };
  if (typeof message.transportOutcome === "string" && TRANSPORT_OUTCOMES.has(message.transportOutcome)) {
    reply.transportOutcome = message.transportOutcome as TestPrintReply["transportOutcome"];
  }
  if (message.error !== undefined) {
    reply.error = typeof message.error === "string" && (has(TEST_PRINT_REFUSALS, message.error) || has(ERROR_CODES, message.error)) ? message.error : "unexpected";
  }
  return reply;
}

/**
 * The relay's own log lines are free text (error messages from `lp`, cloud answers), so none is
 * written as is. A line is reduced to the fixed phrase it starts with, and anything else is withheld.
 * No job id, printer id, name, label or code survives.
 */
const KNOWN_RELAY_LINES: [RegExp, string][] = [
  [/^cycle failed\b/, "cycle failed"],
  [/^cloud unreachable\b/, "cloud unreachable"],
  [/^unexpected failure\b/, "unexpected failure"],
  [/^could not refresh the printer list\b/, "could not refresh the printer list"],
  [/^cloud does not assign these printers\b/, "cloud does not assign these printers"],
  [/^claimed job\b/, "claimed job"],
  [/^job (sent|failed|ambiguous)\b/, "job $1"],
  [/^job \S+ will be retried\b/, "job will be retried"],
  [/^another sender holds this job\b/, "another sender holds a job"],
  [/^claim no longer valid\b/, "claim no longer valid"],
];

export function describeRelayOutput(line: string): string {
  // `<iso time> [relay] <level> <message> {json}`
  const message = line.replace(/^\S+\s+\[relay\]\s+(?:info|warn|error)\s+/, "").trim();
  for (const [pattern, phrase] of KNOWN_RELAY_LINES) {
    const match = pattern.exec(message);
    if (match) return phrase.replace("$1", match[1] ?? "");
  }
  return "output withheld";
}

export function createRelaySupervisor(deps: {
  fork: RelayForker;
  resolveStart: () => Promise<StartResolution>;
  onChange?: (state: SupervisorState) => void;
  /** Called for every relay status event, after `state()` already reflects it. */
  onRelayStatus?: (status: RelayStatus) => void;
  /** Called when the child posts `{type:"stopped"}`, as opposed to simply exiting. */
  onStoppedMessage?: () => void;
  log?: Logger;
  timers?: Timers;
  now?: () => number;
  tuning?: Partial<SupervisorTuning>;
  /** Initial pause and attach state, for a supervisor created after the volunteer chose them. */
  initial?: { paused?: boolean; printerAttached?: boolean };
}): RelaySupervisor {
  const timers = deps.timers ?? systemTimers;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const tuning = { ...DEFAULT_TUNING, ...deps.tuning };

  let state: SupervisorState = {
    phase: "idle",
    blockedReason: null,
    restarts: 0,
    lastExitCode: null,
    lastErrorCode: null,
    relay: null,
  };
  let child: RelayChild | null = null;
  /** True between `start` and `stop`: an exit in this window is a crash. */
  let wanted = false;
  let paused = deps.initial?.paused ?? false;
  let printerAttached = deps.initial?.printerAttached ?? false;
  let attempt = 0;
  let startedAt = 0;
  let restartTimer: unknown = null;
  let launching: Promise<void> | null = null;
  let stopping: Promise<StopOutcome> | null = null;
  let settleStop: ((outcome: StopOutcome) => void) | null = null;
  const settleWaiters: (() => void)[] = [];
  const pendingTestPrints: { printerId: string; resolve: (reply: TestPrintReply) => void; timer: unknown }[] = [];

  const set = (patch: Partial<SupervisorState>) => {
    state = { ...state, ...patch };
    deps.onChange?.(state);
  };

  const clearRestartTimer = () => {
    if (restartTimer !== null) timers.clearTimeout(restartTimer);
    restartTimer = null;
  };

  const releaseSettleWaiters = () => {
    for (const waiter of settleWaiters.splice(0)) waiter();
  };

  const failPendingTestPrints = () => {
    for (const pending of pendingTestPrints.splice(0)) {
      timers.clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "unexpected" });
    }
  };

  const post = (message: unknown) => {
    try {
      child?.postMessage(message);
    } catch (error) {
      log("warn", "relay", `could not message the relay: ${error instanceof Error ? error.name : "error"}`);
    }
  };

  const pipeOutput = (stream: RelayChild["stdout"], level: "info" | "warn") => {
    stream?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) log(level, "relay", describeRelayOutput(line.trim()));
    });
  };

  const onMessage = (message: unknown) => {
    if (!isObject(message)) return;
    switch (message.type) {
      case "event": {
        const event = sanitizeRelayStatus(message.event);
        if (!event) return;
        set({ phase: state.phase === "starting" ? "running" : state.phase, relay: event });
        deps.onRelayStatus?.(event);
        return;
      }
      case "stopped":
        deps.onStoppedMessage?.();
        settleStop?.("stopped");
        releaseSettleWaiters();
        return;
      case "error":
        {
          const code = sanitizeErrorCode(message.code);
          log("warn", "relay", `relay reported ${code}`);
          set({ lastErrorCode: code });
        }
        return;
      case "testPrintResult": {
        const index = pendingTestPrints.findIndex((pending) => pending.printerId === message.printerId);
        if (index < 0) return;
        const [pending] = pendingTestPrints.splice(index, 1);
        timers.clearTimeout(pending.timer);
        pending.resolve(sanitizeTestPrintReply(message));
        return;
      }
      default:
        return;
    }
  };

  const onExit = (exited: RelayChild, code: number | null) => {
    if (child !== exited) return;
    child = null;
    failPendingTestPrints();
    releaseSettleWaiters();
    const expected = !wanted;
    set({ relay: null, lastExitCode: code });
    if (expected) {
      settleStop?.("stopped");
      set({ phase: "idle" });
      return;
    }
    // The child went away on its own.
    if (now() - startedAt >= tuning.healthyAfterMs) attempt = 0;
    const delay = restartDelay(attempt);
    attempt += 1;
    log("warn", "relay", `relay exited (code ${code ?? "none"}); restarting in ${delay} ms`);
    set({ phase: "restarting", restarts: state.restarts + 1 });
    clearRestartTimer();
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      void launch();
    }, delay);
  };

  async function launch(): Promise<void> {
    if (launching) return launching;
    launching = (async () => {
      let resolution: StartResolution;
      try {
        resolution = await deps.resolveStart();
      } catch {
        resolution = { ok: false, reason: "unavailable" };
      }
      // `stop` may have been called while the answer was pending.
      if (!wanted || child) return;
      if (!resolution.ok) {
        wanted = false;
        set({ phase: "blocked", blockedReason: resolution.reason, relay: null });
        return;
      }
      let spawned: RelayChild;
      try {
        spawned = deps.fork();
      } catch (error) {
        log("error", "relay", `could not start the relay: ${error instanceof Error ? error.name : "error"}`);
        set({ phase: "restarting", restarts: state.restarts + 1 });
        const delay = restartDelay(attempt);
        attempt += 1;
        clearRestartTimer();
        restartTimer = timers.setTimeout(() => {
          restartTimer = null;
          void launch();
        }, delay);
        return;
      }
      child = spawned;
      startedAt = now();
      spawned.on("message", (message) => {
        if (child === spawned) onMessage(message);
      });
      spawned.on("exit", (code) => onExit(spawned, code));
      pipeOutput(spawned.stdout, "info");
      pipeOutput(spawned.stderr, "warn");
      set({ phase: "starting", blockedReason: null, lastErrorCode: null, relay: null });
      post({ type: "start", options: { ...resolution.options, printerAttached } });
      if (paused) post({ type: "pause" });
    })().finally(() => {
      launching = null;
    });
    return launching;
  }

  const supervisor: RelaySupervisor = {
    async start() {
      if (stopping) await stopping;
      if (wanted && (child || launching || restartTimer !== null)) return;
      wanted = true;
      attempt = 0;
      set({ restarts: 0 });
      await launch();
    },

    stop() {
      if (stopping) return stopping;
      wanted = false;
      clearRestartTimer();
      if (!child) {
        set({ phase: state.phase === "blocked" ? "blocked" : "idle" });
        return Promise.resolve("not_running");
      }
      const target = child;
      set({ phase: "stopping" });
      stopping = new Promise<StopOutcome>((resolve) => {
        let waited = 0;
        let timer: unknown = null;
        const finish = (outcome: StopOutcome) => {
          if (timer !== null) timers.clearTimeout(timer);
          timer = null;
          settleStop = null;
          resolve(outcome);
        };
        settleStop = finish;
        const arm = () => {
          timer = timers.setTimeout(() => {
            waited += tuning.stopWaitMs;
            if (!supervisor.jobInFlight()) {
              // Nothing is writing, so ending the process cannot cut a label.
              target.kill();
              finish("killed");
            } else if (waited >= tuning.inFlightCeilingMs) {
              log("warn", "relay", "relay is still sending; leaving it to finish");
              finish("abandoned");
            } else {
              arm();
            }
          }, tuning.stopWaitMs);
        };
        arm();
        post({ type: "stop" });
      }).finally(() => {
        stopping = null;
      });
      return stopping;
    },

    async restart() {
      await supervisor.stop();
      // `stopped` arrives a moment before the process exits; starting before that would find the old child still there.
      await supervisor.settled();
      await supervisor.start();
    },

    pause() {
      paused = true;
      post({ type: "pause" });
    },

    resume() {
      paused = false;
      post({ type: "resume" });
    },

    testPrint(printerId) {
      if (!child || state.phase === "stopping") return Promise.resolve({ ok: false, error: "unexpected" });
      return new Promise<TestPrintReply>((resolve) => {
        const timer = timers.setTimeout(() => {
          const index = pendingTestPrints.findIndex((pending) => pending.timer === timer);
          if (index >= 0) pendingTestPrints.splice(index, 1);
          resolve({ ok: false, error: "unexpected" });
        }, tuning.testPrintTimeoutMs);
        pendingTestPrints.push({ printerId, resolve, timer });
        post({ type: "testPrint", printerId });
      });
    },

    setPrinterAttached(attached) {
      printerAttached = attached;
      post({ type: "printerAttached", attached });
    },

    state: () => state,

    jobInFlight: () => state.relay?.inFlight === true,

    settled() {
      if (!child) return Promise.resolve();
      return new Promise<void>((resolve) => void settleWaiters.push(resolve));
    },
  };
  return supervisor;
}
