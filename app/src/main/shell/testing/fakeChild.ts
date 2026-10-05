/** Hand-driven stand-ins for the relay child and the clock. Used by tests only. */

import type { RelayStatus } from "../../../../../vendor/relay/status";
import type { createFakeTimers } from "../../services/testing/fakes";
import type { RelayChild } from "../supervisor";

export function createFakeChild() {
  const messages: unknown[] = [];
  const listeners: { message: ((value: unknown) => void)[]; exit: ((value: number | null) => void)[] } = {
    message: [],
    exit: [],
  };
  const stdoutListeners: ((chunk: string) => void)[] = [];
  const stderrListeners: ((chunk: string) => void)[] = [];
  let kills = 0;

  const child = {
    postMessage: (message: unknown) => void messages.push(message),
    on(event: "message" | "exit", listener: (value: never) => void) {
      listeners[event].push(listener as never);
      return child;
    },
    kill: () => {
      kills += 1;
      return true;
    },
    stdout: { on: (_event: "data", listener: (chunk: string) => void) => void stdoutListeners.push(listener) },
    stderr: { on: (_event: "data", listener: (chunk: string) => void) => void stderrListeners.push(listener) },
  } as unknown as RelayChild;

  return {
    child,
    messages,
    get kills() {
      return kills;
    },
    emitMessage: (message: unknown) => listeners.message.forEach((listener) => listener(message)),
    emitExit: (code: number | null) => listeners.exit.forEach((listener) => listener(code)),
    emitStdout: (text: string) => stdoutListeners.forEach((listener) => listener(text)),
    emitStderr: (text: string) => stderrListeners.forEach((listener) => listener(text)),
    /** Message types posted to the child, in order. */
    types: () => messages.map((message) => (message as { type: string }).type),
  };
}

export type FakeChild = ReturnType<typeof createFakeChild>;

/** A `fork` that hands out a new fake child per call and remembers all of them. */
export function createForkHarness() {
  const children: FakeChild[] = [];
  const fork = () => {
    const fake = createFakeChild();
    children.push(fake);
    return fake.child;
  };
  return { fork, children, last: () => children[children.length - 1] };
}

export function relayStatus(patch: Partial<RelayStatus> = {}): RelayStatus {
  return {
    state: "running",
    cloud: "ok",
    printerIds: ["printer-1"],
    inFlight: false,
    counts: { claimed: 0, sent: 0, failed: 0, ambiguous: 0 },
    lastJobAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    ...patch,
  };
}

/** Runs the pending timer with this delay, once. Fails the test when there is none. */
export function fireTimer(fake: ReturnType<typeof createFakeTimers>, ms: number): void {
  const entry = [...fake.pending].find(([, timer]) => timer.ms === ms);
  if (!entry) throw new Error(`no pending timer of ${ms} ms (have ${[...fake.pending.values()].map((t) => t.ms).join(", ")})`);
  fake.pending.delete(entry[0]);
  entry[1].callback();
}

export const pendingDelays = (fake: ReturnType<typeof createFakeTimers>) => [...fake.pending.values()].map((timer) => timer.ms);
