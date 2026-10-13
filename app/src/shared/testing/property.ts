/**
 * Shared fast-check settings: a fixed seed so a failure replays, and a bounded run count so the suite stays fast.
 * To replay or run deeper without editing code, set FC_SEED, FC_PATH (both printed on failure) or FC_NUM_RUNS:
 *   FC_SEED=123 FC_PATH="4:1:0" pnpm exec vitest run app/src/shared/statusReducer.test.ts
 */

import type { Parameters } from "fast-check";

export const PROPERTY_SEED = 20261013;

function envInteger(name: string): number | undefined {
  const value = process.env[name];
  return value && /^-?\d+$/.test(value) ? Number(value) : undefined;
}

export const propertyParams = (numRuns = 200): Parameters<unknown> => ({
  seed: envInteger("FC_SEED") ?? PROPERTY_SEED,
  numRuns: envInteger("FC_NUM_RUNS") ?? numRuns,
  ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
});
