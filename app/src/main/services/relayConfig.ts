/**
 * Builds the `start` message for the relay utilityProcess in memory. The relay
 * never reads RELAY_* variables, and nothing here touches `process.env` or
 * writes a config file: the token only travels over the message channel.
 */

import path from "node:path";

import { secureApiUrl } from "../../../../vendor/relay/config";
import type { EmbeddedStartOptions } from "../../../../vendor/relay/embeddedProtocol";
import { PRODUCT_NAME } from "../../shared";
import { assertQueueName } from "./queue";
import type { StoredCredentials } from "./secretStore";

export const DEFAULT_API_URL = "https://rsvp.favor.church";

/** `~/Library/Application Support/Favor Printer` */
export function appSupportDir(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", PRODUCT_NAME);
}

export type RelayConfigInput = {
  apiUrl?: string;
  credentials: StoredCredentials;
  /** CUPS queue bound to the selected printer. */
  queue: string;
  appSupportDir: string;
  appVersion: string;
  osVersion: string;
  printerAttached: boolean;
};

/** Throws a plain Error for input the relay would refuse. Never echoes the token. */
export function buildRelayStartOptions(input: RelayConfigInput): EmbeddedStartOptions {
  return {
    apiUrl: secureApiUrl(input.apiUrl ?? DEFAULT_API_URL),
    relayId: input.credentials.relayId,
    token: input.credentials.token,
    spoolDir: path.join(input.appSupportDir, "spool"),
    transport: { kind: "cups", queue: assertQueueName(input.queue) },
    appVersion: input.appVersion,
    osVersion: input.osVersion,
    printerAttached: input.printerAttached,
  };
}
