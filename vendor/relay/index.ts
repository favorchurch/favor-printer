/**
 * Embeddable relay: the same claim, spool and send core as `pnpm relay`, but
 * configured with typed options instead of RELAY_* environment variables, so a
 * host app (the Favor Printer menu-bar app) can run and control it.
 *
 * It never reads `process.env`. Printer ids come from the cloud (`config()`),
 * not from the caller, and everything it reports back is in `RelayStatus`:
 * counts and states only.
 */

import path from "node:path";

import {
  RelayApiClient,
  RelayAuthError,
  RelayNetworkError,
} from "./apiClient";
import { secureApiUrl } from "./config";
import { RELAY_VERSION } from "./createRelay";
import { createCupsTransport, validateCupsQueue } from "./cups";
import { createTcpTransport, type PrinterTransport } from "./printer";
import { Relay, type RelayLogger } from "./relay";
import { FileSpool, SpoolLockedError } from "./spool";
import {
  createStatusTracker,
  type RelayErrorCode,
  type RelayEvent,
  type RelayStatus,
} from "./status";

export type { RelayErrorCode, RelayEvent, RelayState, RelayStatus, CloudState } from "./status";
export { SpoolLockedError } from "./spool";

export type EmbeddedTransport = { kind: "cups"; queue: string } | { kind: "tcp" };

export type EmbeddedRelayOptions = {
  apiUrl: string;
  relayId: string;
  token: string;
  spoolDir: string;
  transport: EmbeddedTransport;
  appVersion: string;
  osVersion: string;
  /** Whether the USB printer is plugged in right now. Sent with every heartbeat. */
  printerAttached: () => boolean;
  /** How often the printer list is re-read from the cloud. Default 60s. */
  configRefreshMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  writeTimeoutMs?: number;
  logger?: RelayLogger;
  onEvent?: (event: RelayEvent) => void;
  /** Test seams. */
  fetch?: typeof fetch;
  transportOverride?: PrinterTransport;
  now?: () => Date;
};

/**
 * `transportOutcome` is set once a label went to the transport: `sent` means
 * the transport accepted it (for CUPS, the queue took the job), not that paper
 * came out. `error` is set when nothing was attempted.
 */
export type TestPrintResult = {
  ok: boolean;
  transportOutcome?: "sent" | "unsent" | "ambiguous";
  error?: "unknown_printer" | "paused" | "busy" | "printer_unavailable" | RelayErrorCode;
};

export type EmbeddedRelay = {
  /** Throws SpoolLockedError when another relay already owns the spool. */
  start(): Promise<void>;
  /** Resolves only after a send that is already writing has finished. */
  stop(): Promise<void>;
  /** No new claims or sends; a send in flight finishes. */
  pause(): void;
  resume(): void;
  snapshot(): RelayStatus;
  /**
   * Fetch a test label from the cloud and print it through the local transport,
   * outside the spool and job state machine. Refused while paused or while a
   * send is in flight.
   */
  testPrint(printerId: string): Promise<TestPrintResult>;
};

const DEFAULT_CONFIG_REFRESH_MS = 60_000;

function transportFor(options: EmbeddedRelayOptions): PrinterTransport {
  if (options.transportOverride) return options.transportOverride;
  if (options.transport.kind === "cups") {
    return createCupsTransport({
      queue: validateCupsQueue(options.transport.queue),
      writeTimeoutMs: options.writeTimeoutMs,
    });
  }
  return createTcpTransport({
    connectTimeoutMs: options.connectTimeoutMs,
    writeTimeoutMs: options.writeTimeoutMs,
  });
}

/** Throws a plain Error for options that cannot work. Never echoes the token. */
function validate(options: EmbeddedRelayOptions) {
  secureApiUrl(options.apiUrl);
  if (!options.relayId.trim()) throw new Error("relayId is required");
  if (!options.token.trim()) throw new Error("token is required");
  if (!options.spoolDir.trim()) throw new Error("spoolDir is required");
  if (options.transport.kind === "cups") validateCupsQueue(options.transport.queue);
}

export function createEmbeddedRelay(options: EmbeddedRelayOptions): EmbeddedRelay {
  validate(options);
  const now = options.now ?? (() => new Date());
  const log: RelayLogger = options.logger ?? (() => undefined);
  const status = createStatusTracker(options.onEvent, now);
  const client = new RelayApiClient({
    baseUrl: options.apiUrl,
    relayId: options.relayId,
    token: options.token,
    fetch: options.fetch,
  });
  const configRefreshMs = options.configRefreshMs ?? DEFAULT_CONFIG_REFRESH_MS;

  /** Printer ids the cloud says this relay serves. Empty means: claim nothing. */
  let printerIds: string[] = [];

  /** Every cloud call reports whether the cloud answered, and whether it still knows us. */
  const observe = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      const result = await call();
      status.cloudOk();
      return result;
    } catch (error) {
      if (error instanceof RelayAuthError) {
        status.cloudRevoked();
        // A revoked laptop stops claiming. The next config refresh restores
        // the list if the credentials work again.
        printerIds = [];
        status.printerIds(printerIds);
      } else if (error instanceof RelayNetworkError) {
        status.cloudUnreachable();
      }
      throw error;
    }
  };

  const api = {
    claim: (ids: string[], limit: number) => observe(() => client.claim(ids, limit)),
    sending: (jobId: string, claimToken: string) =>
      observe(() => client.sending(jobId, claimToken)),
    report: (...args: Parameters<RelayApiClient["report"]>) =>
      observe(() => client.report(...args)),
    heartbeat: async (...args: Parameters<RelayApiClient["heartbeat"]>) => {
      const answer = await observe(() => client.heartbeat(...args));
      status.heartbeat();
      return answer;
    },
  };

  const relay = new Relay({
    api,
    spool: new FileSpool(path.resolve(options.spoolDir)),
    transport: transportFor(options),
    printerIds: () => printerIds,
    heartbeatIdentity: () => {
      let attached = false;
      try {
        attached = options.printerAttached();
      } catch {
        // A failing probe reads as "not attached".
      }
      return {
        appVersion: options.appVersion,
        osVersion: options.osVersion,
        printerAttached: attached,
      };
    },
    signal: (signal) => {
      if (signal.kind === "claimed") status.claimed();
      else if (signal.kind === "outcome") status.outcome(signal.outcome);
      else status.inFlight(signal.value);
    },
    version: RELAY_VERSION,
    pollMs: options.pollMs,
    heartbeatMs: options.heartbeatMs,
    log,
    now,
  });

  async function refreshConfig() {
    try {
      const config = await observe(() => client.config());
      const ids = config.printerIds;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
        printerIds = [];
        status.error("config_invalid");
      } else if (options.transport.kind === "cups" && ids.length !== 1) {
        // One CUPS queue is one physical printer. Serving two printers' jobs
        // from it would print one's labels on the other.
        printerIds = [];
        status.error("config_invalid");
      } else {
        printerIds = ids;
      }
    } catch (error) {
      // Offline or rejected: keep the last known list unless the cloud said no
      // (observe already cleared it). A relay with a list keeps working offline.
      if (!(error instanceof RelayAuthError) && !(error instanceof RelayNetworkError)) {
        status.error("config_unavailable");
      }
      log("warn", "could not refresh the printer list");
    }
    status.printerIds(printerIds);
    relay.nudge();
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping: Promise<void> | null = null;

  return {
    async start() {
      status.reset();
      status.state("starting");
      try {
        await relay.start();
      } catch (error) {
        status.error(error instanceof SpoolLockedError ? "spool_locked" : "unexpected");
        status.state("stopped");
        throw error;
      }
      status.state(relay.isPaused ? "paused" : "running");
      void refreshConfig();
      timer = setInterval(() => void refreshConfig(), configRefreshMs);
    },

    stop() {
      stopping ??= (async () => {
        status.state("stopping");
        if (timer) clearInterval(timer);
        timer = null;
        await relay.stop();
        status.state("stopped");
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },

    pause() {
      relay.pause();
      if (status.snapshot().state === "running") status.state("paused");
    },

    resume() {
      relay.resume();
      if (status.snapshot().state === "paused") status.state("running");
    },

    snapshot: status.snapshot,

    async testPrint(printerId) {
      if (!printerIds.includes(printerId)) return { ok: false, error: "unknown_printer" };
      const blocked = relay.testSendBlocker();
      if (blocked) return { ok: false, error: blocked };
      try {
        const test = await observe(() => client.testPrint(printerId));
        if (test.printerId !== printerId || typeof test.zpl !== "string" || !test.zpl) {
          return { ok: false, error: "unexpected" };
        }
        const result = await relay.sendTestLabel(printerId, test.zpl);
        if (result.kind === "refused") return { ok: false, error: result.reason };
        return { ok: result.outcome === "sent", transportOutcome: result.outcome };
      } catch (error) {
        if (error instanceof RelayAuthError) return { ok: false, error: "credentials_rejected" };
        if (error instanceof RelayNetworkError) return { ok: false, error: "cloud_unreachable" };
        return { ok: false, error: "unexpected" };
      }
    },
  };
}
