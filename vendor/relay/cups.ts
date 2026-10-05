/**
 * USB transport: hands ZPL to a local CUPS queue with `lp -d <queue> -o raw`.
 *
 * Use it when the printer is attached by USB to the relay host and nothing
 * listens on TCP 9100 (a ZD421 without a network module). `-o raw` makes CUPS
 * pass the bytes through untouched; macOS refuses raw queues but still honours
 * `-o raw` on the vendor queue.
 *
 * The outcome rules match the TCP transport:
 *  - `lp` is started BEFORE `hooks.beforeWrite`. If it cannot be started, no
 *    byte left this process and the result is `unsent` (safe to retry).
 *  - After `beforeWrite` agrees, the ZPL goes to lp's stdin. Only exit 0 with a
 *    `request id is ...` line is `sent`. Anything else (non-zero exit, killed by
 *    the timeout, exit 0 without a request id) is `ambiguous`, because CUPS may
 *    already hold the job. The relay never resends an ambiguous job.
 *  - When `beforeWrite` declines, lp gets SIGTERM before any byte is written.
 *    lp cancels the job it opened for stdin when it receives SIGTERM.
 *
 * CUPS gives no printer status back (paper out, head open). The probe only
 * checks that the queue exists and is enabled, and always reports
 * `status_unknown`.
 *
 * Every process is started with execFile and an argument list, never a shell.
 */

import { execFile } from "node:child_process";

import { RelayAuthError } from "./apiClient";
import type { PrinterTransport, ProbeResult, SendResult } from "./printer";

/** Allowed characters for a CUPS queue name. Anything else is rejected outright. */
const QUEUE_NAME = /^[A-Za-z0-9_.-]+$/;
/** CUPS caps destination names at 127 bytes. */
const QUEUE_MAX_LENGTH = 127;

/** Returns the queue name, or throws when it could be read as anything but a queue. */
export function validateCupsQueue(raw: string): string {
  const queue = raw.trim();
  if (!queue) throw new Error("CUPS queue name is required");
  if (queue.length > QUEUE_MAX_LENGTH) {
    throw new Error(`CUPS queue name is longer than ${QUEUE_MAX_LENGTH} characters`);
  }
  if (!QUEUE_NAME.test(queue)) {
    throw new Error("CUPS queue name may contain only letters, digits, '_', '.' and '-'");
  }
  // A leading '-' would be read by lp as an option.
  if (queue.startsWith("-")) throw new Error("CUPS queue name must not start with '-'");
  return queue;
}

export type ProcessExit = {
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The finish timeout fired and the process was killed. */
  timedOut: boolean;
};

/** A started child process. Tests replace this with a fake. */
export type SpawnedProcess = {
  /** Resolves once the process is running. Rejects when it could not be started. */
  started: Promise<void>;
  /** Write `input` to stdin, close it and wait for the exit, killing it after `timeoutMs`. */
  finish(input: Buffer, timeoutMs: number): Promise<ProcessExit>;
  /** Stop the process without closing stdin, so nothing is submitted. */
  cancel(): void;
};

export type Spawner = (file: string, args: readonly string[]) => SpawnedProcess;

const MAX_OUTPUT_BYTES = 64 * 1024;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The real spawner: `execFile` with an argument list. No shell is involved. */
export const execFileSpawner: Spawner = (file, args) => {
  let resolveExit!: (exit: ProcessExit) => void;
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  let timedOut = false;

  const child = execFile(
    file,
    [...args],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
    (error, stdout, stderr) => {
      const failure = error as (Error & { code?: unknown; signal?: string | null }) | null;
      resolveExit({
        code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
        signal: failure?.signal ?? child.signalCode ?? null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || (failure && typeof failure.code !== "number" ? failure.message : ""),
        timedOut,
      });
    },
  );
  // lp can exit before reading all of stdin; that must not crash the relay.
  child.stdin?.on("error", () => undefined);

  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  started.catch(() => undefined);

  return {
    started,
    async finish(input, timeoutMs) {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      try {
        child.stdin?.end(input);
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    },
    cancel() {
      child.kill("SIGTERM");
    },
  };
};

/** `lp` prints `request id is <queue>-<n> (1 file(s))` once CUPS has the job. */
export function parseRequestId(stdout: string): string | null {
  const match = /request id is (\S+)/.exec(stdout);
  return match ? match[1] : null;
}

function describeExit(exit: ProcessExit): string {
  const detail = (exit.stderr || exit.stdout).trim().slice(0, 200);
  const how = exit.timedOut
    ? "lp timed out"
    : exit.code === null
      ? `lp was killed (${exit.signal ?? "signal"})`
      : exit.code === 0
        ? "lp exited 0 without a request id"
        : `lp exited ${exit.code}`;
  return detail ? `${how}: ${detail}` : how;
}

/** The outcome of an lp run once bytes may have reached it. Only a request id is proof. */
export function classifyLpExit(exit: ProcessExit): SendResult {
  if (exit.code === 0 && !exit.timedOut && parseRequestId(exit.stdout)) return { kind: "sent" };
  return { kind: "ambiguous", error: describeExit(exit) };
}

export type CupsTransportOptions = {
  queue: string;
  spawner?: Spawner;
  /** Path or name of lp. */
  lpCommand?: string;
  lpstatCommand?: string;
  /** How long lp may take to accept the job once stdin is closed. */
  writeTimeoutMs?: number;
  probeTimeoutMs?: number;
};

export function createCupsTransport(options: CupsTransportOptions): PrinterTransport {
  const queue = validateCupsQueue(options.queue);
  const spawn = options.spawner ?? execFileSpawner;
  const lp = options.lpCommand ?? "lp";
  const lpstat = options.lpstatCommand ?? "lpstat";
  const writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 3_000;

  return {
    statusUnknown: true,

    // The printer address on the job is ignored: this relay serves one queue.
    async send(_target, zpl, hooks): Promise<SendResult> {
      let child: SpawnedProcess;
      try {
        child = spawn(lp, ["-d", queue, "-o", "raw"]);
        await child.started;
      } catch (error) {
        return { kind: "unsent", error: `could not start lp: ${errorText(error)}` };
      }

      let proceed: boolean;
      try {
        proceed = await hooks.beforeWrite();
      } catch (error) {
        // Rejected credentials reach the relay so it backs off; nothing was written.
        if (error instanceof RelayAuthError) {
          child.cancel();
          throw error;
        }
        proceed = false;
      }
      if (!proceed) {
        child.cancel();
        return { kind: "aborted" };
      }

      try {
        return classifyLpExit(await child.finish(Buffer.from(zpl, "utf8"), writeTimeoutMs));
      } catch (error) {
        return { kind: "ambiguous", error: `lp failed after the write began: ${errorText(error)}` };
      }
    },

    async probe(): Promise<ProbeResult> {
      const status = "status_unknown" as const;
      try {
        const child = spawn(lpstat, ["-p", queue]);
        await child.started;
        const exit = await child.finish(Buffer.alloc(0), probeTimeoutMs);
        if (exit.code !== 0 || exit.timedOut) {
          const detail = (exit.stderr || exit.stdout).trim().slice(0, 200);
          return { reachable: false, status, error: detail || `lpstat exited ${exit.code}` };
        }
        if (/\bdisabled\b/.test(exit.stdout)) {
          return { reachable: false, status, error: `CUPS queue ${queue} is disabled` };
        }
        return { reachable: true, status };
      } catch (error) {
        return { reachable: false, status, error: `could not start lpstat: ${errorText(error)}` };
      }
    },
  };
}
