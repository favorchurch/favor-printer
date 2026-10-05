/**
 * How the relay child is started. The relay never reads RELAY_* variables (its
 * configuration travels over the message channel), so the child gets an
 * explicit environment with every relay, USB shim and simulator key removed:
 * a stray variable in the volunteer's shell cannot change what it does.
 */

import path from "node:path";

import type { RelayChild, RelayForker } from "./supervisor";

export const RELAY_SERVICE_NAME = "Favor Printer relay";

const STRIPPED_PREFIXES = ["RELAY_", "USB_SHIM_", "SIM_"] as const;

export function isStrippedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return STRIPPED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Copies `source` without RELAY_*, USB_SHIM_* and SIM_* keys, and without undefined values. */
export function buildRelayEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isStrippedEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}

/** The slice of `utilityProcess.fork` options used here. */
export type UtilityForkOptions = {
  serviceName: string;
  env: Record<string, string>;
  stdio: "pipe";
};

export type UtilityProcessModule = {
  fork(modulePath: string, args: string[], options: UtilityForkOptions): RelayChild;
};

export function relayForkOptions(source: NodeJS.ProcessEnv): UtilityForkOptions {
  return { serviceName: RELAY_SERVICE_NAME, env: buildRelayEnv(source), stdio: "pipe" };
}

/** `dist/relay.js` sits next to `dist/main.js`. */
export function relayEntryPath(mainDir: string): string {
  return path.join(mainDir, "relay.js");
}

export function createUtilityRelayForker(deps: {
  utilityProcess: UtilityProcessModule;
  entry: string;
  processEnv: NodeJS.ProcessEnv;
}): RelayForker {
  return () => deps.utilityProcess.fork(deps.entry, [], relayForkOptions(deps.processEnv));
}
