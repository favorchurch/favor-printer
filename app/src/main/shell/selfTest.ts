/**
 * Self-test mode, for verifying a packaged build:
 *
 *   Favor\ Printer --self-test-relay=http://127.0.0.1:PORT
 *
 * It forks the bundled relay through the same supervisor the app uses, with a
 * fixed test identity, against a stub cloud on loopback. It waits for the relay
 * to report `running` with the cloud answering, asks it to stop, waits for
 * `stopped`, prints one JSON line and exits. The caller points `userData` at a
 * temporary folder first, so real preferences and secrets are never touched.
 */

import path from "node:path";

import { buildRelayStartOptions } from "../services";
import { silentLogger, type Logger } from "./log";
import { createRelaySupervisor, type RelayForker, type StopOutcome, type SupervisorTuning } from "./supervisor";
import type { Timers } from "../services";

export const SELF_TEST_FLAG = "--self-test-relay=";

/** Not a real credential: it only has to be well formed for a stub cloud. */
export const SELF_TEST_IDENTITY = { relayId: "self-test-relay", token: "self-test-token" } as const;
export const SELF_TEST_QUEUE = "Favor_SelfTest";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type SelfTestArg =
  | { kind: "none" }
  | { kind: "run"; apiUrl: string }
  | { kind: "invalid"; reason: string };

/** Accepts `http://<loopback>:<port>` and nothing else: no credentials, path, query or other host. */
export function parseSelfTestArg(argv: readonly string[]): SelfTestArg {
  const arg = argv.find((value) => value.startsWith(SELF_TEST_FLAG));
  if (arg === undefined) return { kind: "none" };

  let url: URL;
  try {
    url = new URL(arg.slice(SELF_TEST_FLAG.length));
  } catch {
    return { kind: "invalid", reason: "not a URL" };
  }
  if (url.protocol !== "http:") return { kind: "invalid", reason: "must be http" };
  if (!LOOPBACK_HOSTS.has(url.hostname)) return { kind: "invalid", reason: "must be a loopback address" };
  if (!url.port) return { kind: "invalid", reason: "needs a port" };
  if (url.username || url.password) return { kind: "invalid", reason: "must not carry credentials" };
  if (url.pathname !== "/" || url.search || url.hash) return { kind: "invalid", reason: "must be an origin only" };
  return { kind: "run", apiUrl: url.origin };
}

export type SelfTestResult = {
  type: "self-test";
  ok: boolean;
  /** The relay reported `running` with the cloud answering. */
  running: boolean;
  cloud: string | null;
  stopOutcome: StopOutcome;
  /** Present when the run failed: a fixed phrase, never remote text. */
  error?: "start_blocked" | "timeout" | "stop_failed";
};

export const SELF_TEST_TIMEOUT_MS = 30_000;

export async function runSelfTest(deps: {
  apiUrl: string;
  fork: RelayForker;
  /** A temporary folder: the relay's spool lives under it. */
  workDir: string;
  appVersion: string;
  osVersion: string;
  timers: Timers;
  timeoutMs?: number;
  tuning?: Partial<SupervisorTuning>;
  log?: Logger;
}): Promise<SelfTestResult> {
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  let stoppedMessage = false;
  const supervisor = createRelaySupervisor({
    onStoppedMessage: () => {
      stoppedMessage = true;
    },
    fork: deps.fork,
    log: deps.log ?? silentLogger,
    timers: deps.timers,
    tuning: deps.tuning,
    resolveStart: async () => ({
      ok: true,
      options: buildRelayStartOptions({
        apiUrl: deps.apiUrl,
        credentials: SELF_TEST_IDENTITY,
        queue: SELF_TEST_QUEUE,
        appSupportDir: path.resolve(deps.workDir),
        appVersion: deps.appVersion,
        osVersion: deps.osVersion,
        printerAttached: false,
      }),
    }),
    onRelayStatus: (status) => {
      if (status.state === "running" && status.cloud === "ok") markReady();
    },
  });

  await supervisor.start();
  if (supervisor.state().phase === "blocked") {
    return { type: "self-test", ok: false, running: false, cloud: null, stopOutcome: "not_running", error: "start_blocked" };
  }

  let timer: unknown = null;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = deps.timers.setTimeout(() => resolve("timeout"), deps.timeoutMs ?? SELF_TEST_TIMEOUT_MS);
  });
  const reached = await Promise.race([ready.then(() => "ready" as const), timedOut]);
  if (timer !== null) deps.timers.clearTimeout(timer);

  const relay = supervisor.state().relay;
  const stopOutcome = await supervisor.stop();
  const running = reached === "ready";
  // The child must say so itself: a bare exit is not a clean stop.
  const stopped = stopOutcome === "stopped" && stoppedMessage;
  return {
    type: "self-test",
    ok: running && stopped,
    running,
    cloud: relay?.cloud ?? null,
    stopOutcome,
    ...(!running ? { error: "timeout" as const } : !stopped ? { error: "stop_failed" as const } : {}),
  };
}
