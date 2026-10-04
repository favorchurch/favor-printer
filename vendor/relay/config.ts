/** Relay configuration, read from the environment. */

import path from "node:path";

import { validateCupsQueue } from "./cups";

/**
 * `tcp`: raw TCP 9100 to the address on the printer record (default).
 * `cups`: `lp -d <queue> -o raw` on this machine, for a USB-attached printer.
 */
export type RelayTransportKind = "tcp" | "cups";

export type RelayConfig = {
  apiUrl: string;
  relayId: string;
  token: string;
  printerIds: string[];
  spoolDir: string;
  pollMs: number;
  heartbeatMs: number;
  connectTimeoutMs: number;
  writeTimeoutMs: number;
  transport: RelayTransportKind;
  /** Set only when `transport` is `cups`. */
  cupsQueue: string | null;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The bearer token travels in every request, so require https except on loopback. */
export function secureApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RELAY_API_URL must be a valid URL");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return raw;
  throw new Error("RELAY_API_URL must use https (http is allowed only for localhost)");
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const printerIds = required(env, "RELAY_PRINTER_IDS")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (printerIds.length === 0) throw new Error("RELAY_PRINTER_IDS is required");

  const transport = (env.RELAY_TRANSPORT?.trim() || "tcp") as RelayTransportKind;
  if (transport !== "tcp" && transport !== "cups") {
    throw new Error("RELAY_TRANSPORT must be tcp or cups");
  }
  let cupsQueue: string | null = null;
  if (transport === "cups") {
    cupsQueue = validateCupsQueue(required(env, "RELAY_CUPS_QUEUE"));
    // One queue is one physical printer. Sending two printers' jobs to it would
    // print one venue's labels on another's printer.
    if (printerIds.length !== 1) {
      throw new Error("RELAY_TRANSPORT=cups serves exactly one printer id in RELAY_PRINTER_IDS");
    }
  }

  return {
    apiUrl: secureApiUrl(required(env, "RELAY_API_URL")),
    relayId: required(env, "RELAY_ID"),
    token: required(env, "RELAY_TOKEN"),
    printerIds,
    spoolDir: path.resolve(env.RELAY_SPOOL_DIR?.trim() || "relay-spool"),
    pollMs: positiveInt(env, "RELAY_POLL_MS", 2_000),
    heartbeatMs: positiveInt(env, "RELAY_HEARTBEAT_MS", 15_000),
    connectTimeoutMs: positiveInt(env, "RELAY_CONNECT_TIMEOUT_MS", 5_000),
    writeTimeoutMs: positiveInt(env, "RELAY_WRITE_TIMEOUT_MS", 10_000),
    transport,
    cupsQueue,
  };
}
