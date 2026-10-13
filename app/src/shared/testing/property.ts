/** Shared fast-check settings: a fixed seed so a failure replays, and a bounded run count so the suite stays fast. */

import type { Parameters } from "fast-check";

export const PROPERTY_SEED = 20261013;

export const propertyParams = (numRuns = 200): Parameters<unknown> => ({ seed: PROPERTY_SEED, numRuns });
