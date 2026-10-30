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
import { validateLocalWindowsScriptPath, validateWindowsQueueName } from "../../../../vendor/relay/windowsSpooler";
import type { StoredCredentials } from "./secretStore";

export const DEFAULT_API_URL = "https://rsvp.favor.church";

/** `~/Library/Application Support/Favor Printer` */
export function appSupportDir(homeDir: string, platform: NodeJS.Platform = "darwin", appData?: string): string {
  if (platform === "win32") return path.win32.join(appData ?? path.win32.join(homeDir, "AppData", "Roaming"), PRODUCT_NAME);
  return path.posix.join(homeDir, "Library", "Application Support", PRODUCT_NAME);
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
  platform?: NodeJS.Platform;
  windowsScriptPath?: string;
};

/** Throws a plain Error for input the relay would refuse. Never echoes the token. */
export function buildRelayStartOptions(input: RelayConfigInput): EmbeddedStartOptions {
  return {
    apiUrl: secureApiUrl(input.apiUrl ?? DEFAULT_API_URL),
    relayId: input.credentials.relayId,
    token: input.credentials.token,
    spoolDir: path.join(input.appSupportDir, "spool"),
    transport: input.platform === "win32"
      ? { kind: "windows", queue: validateWindowsQueueName(input.queue), scriptPath: validateLocalWindowsScriptPath(input.windowsScriptPath ?? "") }
      : { kind: "cups", queue: assertQueueName(input.queue) },
    appVersion: input.appVersion,
    osVersion: input.osVersion,
    printerAttached: input.printerAttached,
  };
}
