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

/**
 * Electron's `userData`. macOS: `~/Library/Application Support/Favor Printer`. Windows: `%APPDATA%\\Favor Printer`.
 * On Windows it must stay here: the token is encrypted with a key Chromium keeps in `<userData>\\Local State`, so
 * moving `userData` strands the token and the PC loses its pairing.
 */
export function appSupportDir(homeDir: string, platform: NodeJS.Platform = "darwin", appData?: string): string {
  if (platform === "win32") return path.win32.join(appData || path.win32.join(homeDir, "AppData", "Roaming"), PRODUCT_NAME);
  return path.posix.join(homeDir, "Library", "Application Support", PRODUCT_NAME);
}

/**
 * Where the Windows relay keeps its token, preferences and spool: `%LOCALAPPDATA%\\Favor Printer`. These describe this
 * PC, so they stay out of the roaming profile that follows an account to other PCs. See windowsDataMigration.ts.
 */
export function windowsStateDir(homeDir: string, localAppData?: string): string {
  return path.win32.join(localAppData || path.win32.join(homeDir, "AppData", "Local"), PRODUCT_NAME);
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
