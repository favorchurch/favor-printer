/**
 * Decides whether the relay may start and, when it may, builds its `start`
 * options in memory. The order is the safety order: a revoked laptop and a
 * missing enrollment come before the legacy check, and the legacy check comes
 * before anything that reads the token.
 */

import type { EmbeddedStartOptions } from "../../../../vendor/relay/embeddedProtocol";
import { buildRelayStartOptions, type LegacyRelay, type SecretStore } from "../services";
import type { StartResolution } from "./supervisor";

export type StartGateDeps = {
  isRevoked(): boolean;
  secrets: Pick<SecretStore, "load">;
  legacy: Pick<LegacyRelay, "canStartRelay">;
  /** The CUPS queue bound to the printer, or null before one exists. */
  queue(): string | null;
  printerAttached(): boolean;
  appSupportDir: string;
  appVersion: string;
  osVersion: string;
  apiUrl?: string;
};

export function createStartResolver(deps: StartGateDeps): () => Promise<StartResolution> {
  return async () => {
    if (deps.isRevoked()) return { ok: false, reason: "revoked" };

    const gate = await deps.legacy.canStartRelay();
    if (!gate.allowed) return { ok: false, reason: "legacy_loaded" };

    const credentials = await deps.secrets.load();
    if (!credentials) return { ok: false, reason: "not_enrolled" };

    const queue = deps.queue();
    if (!queue) return { ok: false, reason: "no_queue" };

    let options: EmbeddedStartOptions;
    try {
      options = buildRelayStartOptions({
        apiUrl: deps.apiUrl,
        credentials,
        queue,
        appSupportDir: deps.appSupportDir,
        appVersion: deps.appVersion,
        osVersion: deps.osVersion,
        printerAttached: deps.printerAttached(),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, options };
  };
}
