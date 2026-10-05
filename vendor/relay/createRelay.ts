import { RelayApiClient } from "./apiClient";
import type { RelayConfig } from "./config";
import { createCupsTransport } from "./cups";
import { createTcpTransport, type PrinterTransport } from "./printer";
import { Relay, type RelayLogger } from "./relay";
import { FileSpool } from "./spool";

export const RELAY_VERSION = "1.0.0";

export const consoleLogger: RelayLogger = (level, message, data) => {
  const line = `${new Date().toISOString()} [relay] ${level} ${message}`;
  const out = data ? `${line} ${JSON.stringify(data)}` : line;
  (level === "info" ? console.log : level === "warn" ? console.warn : console.error)(out);
};

export function createTransportFromConfig(config: RelayConfig): PrinterTransport {
  if (config.transport === "cups") {
    if (!config.cupsQueue) throw new Error("RELAY_CUPS_QUEUE is required for the cups transport");
    return createCupsTransport({
      queue: config.cupsQueue,
      writeTimeoutMs: config.writeTimeoutMs,
    });
  }
  return createTcpTransport({
    connectTimeoutMs: config.connectTimeoutMs,
    writeTimeoutMs: config.writeTimeoutMs,
  });
}

export function createRelayFromConfig(config: RelayConfig, log: RelayLogger = consoleLogger) {
  return new Relay({
    api: new RelayApiClient({
      baseUrl: config.apiUrl,
      relayId: config.relayId,
      token: config.token,
    }),
    spool: new FileSpool(config.spoolDir),
    transport: createTransportFromConfig(config),
    printerIds: config.printerIds,
    version: RELAY_VERSION,
    pollMs: config.pollMs,
    heartbeatMs: config.heartbeatMs,
    log,
  });
}
