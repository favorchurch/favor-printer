/** Hand-driven stand-ins for the adapters the services take. Used by tests only. */

import { expect } from "vitest";

import type { CommandResult, CommandRunner } from "../command";
import type { Timers } from "../timers";

export const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", timedOut: false });

export const fail = (code: number | null, stderr = "", timedOut = false): CommandResult => ({
  code,
  stdout: "",
  stderr,
  timedOut,
});

export type RecordedCall = { file: string; args: readonly string[] };

/** A runner that answers from `handler` and records every call. */
export function scriptedRunner(handler: (file: string, args: readonly string[]) => CommandResult) {
  const calls: RecordedCall[] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    return handler(file, args);
  };
  return { run, calls };
}

/** Every call is an absolute binary plus plain string arguments: no command line is ever assembled. */
export function expectArgvOnly(calls: readonly RecordedCall[]) {
  for (const call of calls) {
    expect(call.file).toMatch(/^\/[^\s]+$/);
    expect(Array.isArray(call.args)).toBe(true);
    for (const arg of call.args) expect(typeof arg).toBe("string");
  }
}

type Pending = { callback: () => void; ms: number; kind: "timeout" | "interval" };

export function createFakeTimers() {
  let next = 1;
  const pending = new Map<number, Pending>();
  const schedule = (kind: Pending["kind"]) => (callback: () => void, ms: number) => {
    const id = next++;
    pending.set(id, { callback, ms, kind });
    return id;
  };
  const timers: Timers = {
    setTimeout: schedule("timeout"),
    clearTimeout: (handle) => void pending.delete(handle as number),
    setInterval: schedule("interval"),
    clearInterval: (handle) => void pending.delete(handle as number),
  };
  return {
    timers,
    pending,
    /** Runs every pending timer of `kind` once. One-shot timers are removed first. */
    fire(kind: Pending["kind"]) {
      for (const [id, timer] of [...pending]) {
        if (timer.kind !== kind) continue;
        if (kind === "timeout") pending.delete(id);
        timer.callback();
      }
    },
  };
}
