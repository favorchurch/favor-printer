import { describe, expect, it, vi } from "vitest";

import { parseParentMessage } from "../../../../vendor/relay/embeddedProtocol";
import { createFakeTimers } from "../services/testing/fakes";
import {
  createRelaySupervisor,
  describeRelayOutput,
  restartDelay,
  sanitizeErrorCode,
  sanitizeRelayStatus,
  sanitizeTestPrintReply,
  type BlockReason,
  type StartResolution,
} from "./supervisor";
import { createForkHarness, fireTimer, pendingDelays, relayStatus } from "./testing/fakeChild";

const OPTIONS = {
  apiUrl: "https://rsvp.favor.church",
  relayId: "relay-1",
  token: "tok-secret",
  spoolDir: "/tmp/spool",
  transport: { kind: "cups", queue: "Favor_Zebra" },
  appVersion: "0.1.0",
  osVersion: "macOS 15",
} as const;

const TUNING = { healthyAfterMs: 5_000, stopWaitMs: 100, inFlightCeilingMs: 300, testPrintTimeoutMs: 700 };

function setup(options: { resolve?: () => Promise<StartResolution>; initial?: { paused?: boolean; printerAttached?: boolean } } = {}) {
  const harness = createForkHarness();
  const timers = createFakeTimers();
  let clock = 0;
  const onChange = vi.fn();
  const onRelayStatus = vi.fn();
  const resolveStart = vi.fn(options.resolve ?? (async () => ({ ok: true, options: { ...OPTIONS } }) as StartResolution));
  const supervisor = createRelaySupervisor({
    fork: harness.fork,
    resolveStart,
    onChange,
    onRelayStatus,
    timers: timers.timers,
    now: () => clock,
    tuning: TUNING,
    initial: options.initial,
  });
  return { ...harness, timers, supervisor, resolveStart, onChange, onRelayStatus, advance: (ms: number) => void (clock += ms) };
}

describe("restartDelay", () => {
  it("grows and then holds at the last step", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(restartDelay)).toEqual([1000, 2000, 5000, 15000, 30000, 60000, 60000, 60000]);
  });
});

describe("start gating", () => {
  it.each<BlockReason>(["legacy_loaded", "not_enrolled", "revoked", "no_queue", "unavailable"])(
    "does not fork the relay when start is refused: %s",
    async (reason) => {
      const { supervisor, children } = setup({ resolve: async () => ({ ok: false, reason }) });
      await supervisor.start();
      expect(children).toHaveLength(0);
      expect(supervisor.state()).toMatchObject({ phase: "blocked", blockedReason: reason });
    },
  );

  it("treats a resolver that throws as blocked, not as a crash", async () => {
    const { supervisor, children } = setup({
      resolve: async () => {
        throw new Error("boom");
      },
    });
    await supervisor.start();
    expect(children).toHaveLength(0);
    expect(supervisor.state()).toMatchObject({ phase: "blocked", blockedReason: "unavailable" });
  });

  it("starts once the gate opens", async () => {
    let allowed = false;
    const { supervisor, children } = setup({
      resolve: async () => (allowed ? { ok: true, options: { ...OPTIONS } } : { ok: false, reason: "not_enrolled" }),
    });
    await supervisor.start();
    expect(children).toHaveLength(0);
    allowed = true;
    await supervisor.start();
    expect(children).toHaveLength(1);
  });
});

describe("start", () => {
  it("forks once and sends a start message that the relay's own parser accepts", async () => {
    const { supervisor, children, last } = setup();
    await supervisor.start();
    await supervisor.start();
    expect(children).toHaveLength(1);

    const [first] = last().messages;
    expect(parseParentMessage(first)).toEqual({ type: "start", options: { ...OPTIONS, printerAttached: false } });
    expect(supervisor.state().phase).toBe("starting");
  });

  it("starts with the current printer state", async () => {
    const { supervisor, last } = setup({ initial: { printerAttached: true } });
    await supervisor.start();
    expect(last().messages[0]).toMatchObject({ type: "start", options: { printerAttached: true } });
  });

  it("is running after the first status event, and reports each event", async () => {
    const { supervisor, last, onRelayStatus } = setup();
    await supervisor.start();
    const status = relayStatus();
    last().emitMessage({ type: "event", event: status });
    expect(supervisor.state()).toMatchObject({ phase: "running", relay: status });
    expect(onRelayStatus).toHaveBeenCalledWith(status);
  });

  it("ignores messages that are not well formed", async () => {
    const { supervisor, last, onRelayStatus } = setup();
    await supervisor.start();
    last().emitMessage({ type: "event", event: { state: 1 } });
    last().emitMessage("nonsense");
    last().emitMessage(null);
    expect(onRelayStatus).not.toHaveBeenCalled();
    expect(supervisor.state().relay).toBeNull();
  });

  it("records the error code the relay reports", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    last().emitMessage({ type: "error", code: "spool_locked" });
    expect(supervisor.state().lastErrorCode).toBe("spool_locked");
  });
});

describe("pause, resume and printerAttached", () => {
  it("forwards pause and resume", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    supervisor.pause();
    supervisor.resume();
    expect(last().types()).toEqual(["start", "pause", "resume"]);
  });

  it("re-applies a pause after the relay restarts", async () => {
    const { supervisor, children, last, timers } = setup();
    await supervisor.start();
    supervisor.pause();
    last().emitExit(1);
    fireTimer(timers, 1000);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(children[1].types()).toEqual(["start", "pause"]);
  });

  it("forwards attach and detach exactly as the relay parses them", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    supervisor.setPrinterAttached(true);
    supervisor.setPrinterAttached(false);
    const forwarded = last().messages.slice(1);
    expect(forwarded).toEqual([
      { type: "printerAttached", attached: true },
      { type: "printerAttached", attached: false },
    ]);
    expect(forwarded.map(parseParentMessage)).toEqual(forwarded);
  });

  it("remembers the printer state for the next start when there is no child", async () => {
    const { supervisor, last } = setup();
    supervisor.setPrinterAttached(true);
    await supervisor.start();
    expect(last().messages[0]).toMatchObject({ options: { printerAttached: true } });
  });
});

describe("testPrint", () => {
  it("forwards the request and resolves with the relay's answer", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const pending = supervisor.testPrint("printer-1");
    expect(last().messages.at(-1)).toEqual({ type: "testPrint", printerId: "printer-1" });
    expect(parseParentMessage(last().messages.at(-1))).not.toBeNull();

    last().emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: true, transportOutcome: "sent" });
    await expect(pending).resolves.toEqual({ ok: true, transportOutcome: "sent" });
  });

  it("passes the relay's refusal through", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const pending = supervisor.testPrint("printer-1");
    last().emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: false, error: "paused" });
    await expect(pending).resolves.toEqual({ ok: false, error: "paused" });
  });

  it("passes printer_unavailable through, so the app can tell it from a failure", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const pending = supervisor.testPrint("printer-1");
    last().emitMessage({ type: "testPrintResult", printerId: "printer-1", ok: false, error: "printer_unavailable" });
    await expect(pending).resolves.toEqual({ ok: false, error: "printer_unavailable" });
  });

  it("fails without a relay", async () => {
    const { supervisor } = setup();
    await expect(supervisor.testPrint("printer-1")).resolves.toEqual({ ok: false, error: "unexpected" });
  });

  it("gives up when the relay never answers", async () => {
    const { supervisor, timers } = setup();
    await supervisor.start();
    const pending = supervisor.testPrint("printer-1");
    fireTimer(timers, 700);
    await expect(pending).resolves.toEqual({ ok: false, error: "unexpected" });
  });

  it("fails when the relay exits first", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const pending = supervisor.testPrint("printer-1");
    last().emitExit(1);
    await expect(pending).resolves.toEqual({ ok: false, error: "unexpected" });
  });
});

describe("crash and restart", () => {
  it("restarts after an unrequested exit and surfaces the restart", async () => {
    const { supervisor, children, last, timers } = setup();
    await supervisor.start();
    last().emitMessage({ type: "event", event: relayStatus() });
    last().emitExit(1);

    expect(supervisor.state()).toMatchObject({ phase: "restarting", restarts: 1, lastExitCode: 1, relay: null });
    expect(pendingDelays(timers)).toEqual([1000]);

    fireTimer(timers, 1000);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(supervisor.state().phase).toBe("starting");
    expect(children[1].messages[0]).toMatchObject({ type: "start" });
  });

  it("backs off while the relay keeps failing, then resets after a healthy run", async () => {
    const { supervisor, children, last, timers, advance } = setup();
    await supervisor.start();

    const delays: number[] = [];
    for (let crash = 0; crash < 4; crash += 1) {
      last().emitExit(1);
      delays.push(pendingDelays(timers)[0]);
      fireTimer(timers, pendingDelays(timers)[0]);
      await vi.waitFor(() => expect(children).toHaveLength(crash + 2));
    }
    expect(delays).toEqual([1000, 2000, 5000, 15000]);

    advance(6_000);
    last().emitExit(1);
    expect(pendingDelays(timers)).toEqual([1000]);
  });

  it("checks the gate again before each restart", async () => {
    let revoked = false;
    const { supervisor, children, last, timers } = setup({
      resolve: async () => (revoked ? { ok: false, reason: "revoked" } : { ok: true, options: { ...OPTIONS } }),
    });
    await supervisor.start();
    last().emitExit(1);
    revoked = true;
    fireTimer(timers, 1000);
    await vi.waitFor(() => expect(supervisor.state().phase).toBe("blocked"));
    expect(children).toHaveLength(1);
    expect(supervisor.state().blockedReason).toBe("revoked");
  });

  it("retries after a fork that throws", async () => {
    const timers = createFakeTimers();
    const harness = createForkHarness();
    let failures = 1;
    const supervisor = createRelaySupervisor({
      fork: () => {
        if (failures-- > 0) throw new Error("no process");
        return harness.fork();
      },
      resolveStart: async () => ({ ok: true, options: { ...OPTIONS } }),
      timers: timers.timers,
      tuning: TUNING,
    });
    await supervisor.start();
    expect(supervisor.state().phase).toBe("restarting");
    fireTimer(timers, 1000);
    await vi.waitFor(() => expect(harness.children).toHaveLength(1));
  });

  it("does not restart after stop", async () => {
    const { supervisor, children, last, timers } = setup();
    await supervisor.start();
    const stopping = supervisor.stop();
    last().emitMessage({ type: "stopped" });
    await stopping;
    last().emitExit(0);
    expect(timers.pending.size).toBe(0);
    expect(children).toHaveLength(1);
    expect(supervisor.state().phase).toBe("idle");
  });
});

describe("stop", () => {
  it("returns not_running when there is nothing to stop", async () => {
    const { supervisor } = setup();
    await expect(supervisor.stop()).resolves.toBe("not_running");
  });

  it("sends stop and waits for the stopped message", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const stopping = supervisor.stop();
    expect(last().types()).toEqual(["start", "stop"]);
    expect(supervisor.state().phase).toBe("stopping");

    last().emitMessage({ type: "stopped" });
    await expect(stopping).resolves.toBe("stopped");
    expect(last().kills).toBe(0);
  });

  it("returns the same promise for a second stop", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const first = supervisor.stop();
    const second = supervisor.stop();
    expect(second).toBe(first);
    last().emitMessage({ type: "stopped" });
    await first;
    expect(last().types().filter((type) => type === "stop")).toHaveLength(1);
  });

  it("ends the child after the wait when nothing is sending", async () => {
    const { supervisor, last, timers } = setup();
    await supervisor.start();
    last().emitMessage({ type: "event", event: relayStatus({ inFlight: false }) });
    const stopping = supervisor.stop();
    fireTimer(timers, 100);
    await expect(stopping).resolves.toBe("killed");
    expect(last().kills).toBe(1);
  });

  it("never kills a child that is still sending", async () => {
    const { supervisor, last, timers } = setup();
    await supervisor.start();
    last().emitMessage({ type: "event", event: relayStatus({ inFlight: true }) });
    const stopping = supervisor.stop();

    // 100 ms and 200 ms slices pass while a send is writing: still waiting.
    fireTimer(timers, 100);
    fireTimer(timers, 100);
    expect(last().kills).toBe(0);
    // The 300 ms ceiling: give up waiting, still do not kill.
    fireTimer(timers, 100);
    await expect(stopping).resolves.toBe("abandoned");
    expect(last().kills).toBe(0);
  });

  it("finishes early when the send completes inside the wait", async () => {
    const { supervisor, last, timers } = setup();
    await supervisor.start();
    last().emitMessage({ type: "event", event: relayStatus({ inFlight: true }) });
    const stopping = supervisor.stop();
    fireTimer(timers, 100);
    last().emitMessage({ type: "stopped" });
    await expect(stopping).resolves.toBe("stopped");
    expect(last().kills).toBe(0);
  });

  it("does not start a relay that stop cancelled while the gate was pending", async () => {
    let release: (value: StartResolution) => void = () => undefined;
    const { supervisor, children } = setup({ resolve: () => new Promise<StartResolution>((resolve) => (release = resolve)) });
    const starting = supervisor.start();
    const stopping = supervisor.stop();
    release({ ok: true, options: { ...OPTIONS } });
    await starting;
    await stopping;
    expect(children).toHaveLength(0);
  });
});

describe("restart", () => {
  it("stops the old child, then starts a new one with fresh options", async () => {
    const { supervisor, children, last } = setup();
    await supervisor.start();
    const restarting = supervisor.restart();
    const old = last();
    old.emitMessage({ type: "stopped" });
    // The process exits a moment after it says stopped; the new one must not start before that.
    await Promise.resolve();
    expect(children).toHaveLength(1);
    old.emitExit(0);
    await restarting;
    expect(children).toHaveLength(2);
    expect(children[1].messages[0]).toMatchObject({ type: "start" });
  });
});

describe("settled", () => {
  it("resolves at once when no child runs", async () => {
    const { supervisor } = setup();
    await expect(supervisor.settled()).resolves.toBeUndefined();
  });

  it("waits for the child to report stopped", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const done = vi.fn();
    void supervisor.settled().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();

    last().emitMessage({ type: "stopped" });
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("waits for the child to exit", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const done = vi.fn();
    void supervisor.settled().then(done);
    last().emitExit(0);
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("releases every waiter", async () => {
    const { supervisor, last } = setup();
    await supervisor.start();
    const done = vi.fn();
    void supervisor.settled().then(done);
    void supervisor.settled().then(done);
    last().emitMessage({ type: "stopped" });
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2));
  });

  it("still waits after stop gave up on a send that was writing, and releases when the relay finishes", async () => {
    const { supervisor, last, timers } = setup();
    await supervisor.start();
    last().emitMessage({ type: "event", event: relayStatus({ inFlight: true }) });
    const stopping = supervisor.stop();
    fireTimer(timers, 100);
    fireTimer(timers, 100);
    fireTimer(timers, 100);
    await expect(stopping).resolves.toBe("abandoned");

    const done = vi.fn();
    void supervisor.settled().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(last().kills).toBe(0);

    last().emitMessage({ type: "stopped" });
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });
});

describe("sanitizeRelayStatus", () => {
  it("keeps a well formed status as it is", () => {
    const status = relayStatus({
      lastJobAt: "2026-10-04T01:00:00.000Z",
      lastHeartbeatAt: "2026-10-04T01:00:15.000Z",
      lastError: "send_ambiguous",
      counts: { claimed: 3, sent: 2, failed: 0, ambiguous: 1 },
    });
    expect(sanitizeRelayStatus(status)).toEqual(status);
  });

  it("drops fields it does not know", () => {
    const out = sanitizeRelayStatus({ ...relayStatus(), attendeeName: "Jane Q. Attendee", zpl: "^XA^XZ", securityCode: "483920" });
    expect(Object.keys(out ?? {}).sort()).toEqual(
      ["cloud", "counts", "inFlight", "lastError", "lastHeartbeatAt", "lastJobAt", "printerIds", "state"].sort(),
    );
  });

  it.each([null, undefined, "running", 5, [], {}, { state: "running" }, { state: "x", cloud: "ok" }, { state: "running", cloud: "Jane" }])(
    "refuses %j",
    (raw) => {
      expect(sanitizeRelayStatus(raw)).toBeNull();
    },
  );

  it("turns text where a count, time, code or id belongs into a safe value", () => {
    const out = sanitizeRelayStatus({
      ...relayStatus(),
      counts: { claimed: "Jane Q. Attendee", sent: -1, failed: 1.5, ambiguous: { name: "Jane" } },
      lastJobAt: "Jane Q. Attendee arrived 2026-10-04T01:00:00.000Z",
      lastHeartbeatAt: { name: "Jane" },
      lastError: "label for Jane Q. Attendee failed",
      printerIds: ["printer-1", "Jane Q. Attendee", "^XA^FDJane^XZ", { name: "Jane" }, "x".repeat(200)],
      inFlight: "yes",
    });
    expect(out).toEqual({
      state: "running",
      cloud: "ok",
      printerIds: ["printer-1"],
      inFlight: false,
      counts: { claimed: 0, sent: 0, failed: 0, ambiguous: 0 },
      lastJobAt: null,
      lastHeartbeatAt: null,
      lastError: null,
    });
  });

  it("does not share objects with the message it was given", () => {
    const status = relayStatus({ printerIds: ["printer-1"] });
    const out = sanitizeRelayStatus(status);
    expect(out?.printerIds).not.toBe(status.printerIds);
    expect(out?.counts).not.toBe(status.counts);
  });
});

describe("sanitizeErrorCode and sanitizeTestPrintReply", () => {
  it.each(["cloud_unreachable", "credentials_rejected", "config_unavailable", "config_invalid", "spool_locked", "invalid_options", "send_failed", "send_ambiguous", "unexpected", "bad_message"])(
    "passes %s",
    (code) => {
      expect(sanitizeErrorCode(code)).toBe(code);
    },
  );

  it.each(["Jane Q. Attendee", "^XA^XZ", "", 5, null, { code: "unexpected" }, "__proto__", "constructor"])("replaces %j with unexpected", (code) => {
    expect(sanitizeErrorCode(code)).toBe("unexpected");
  });

  it("keeps only the fixed parts of a test print reply", () => {
    expect(sanitizeTestPrintReply({ ok: true, transportOutcome: "sent", zpl: "^XA^XZ", name: "Jane" })).toEqual({ ok: true, transportOutcome: "sent" });
    expect(sanitizeTestPrintReply({ ok: false, error: "busy" })).toEqual({ ok: false, error: "busy" });
    expect(sanitizeTestPrintReply({ ok: false, error: "cloud_unreachable" })).toEqual({ ok: false, error: "cloud_unreachable" });
  });

  it.each(["unknown_printer", "paused", "busy", "printer_unavailable"])("passes the test print refusal %s", (error) => {
    expect(sanitizeTestPrintReply({ ok: false, error })).toEqual({ ok: false, error });
  });

  it("replaces free text in a test print reply", () => {
    expect(sanitizeTestPrintReply({ ok: false, error: "lp failed for Jane Q. Attendee ^XA^XZ", transportOutcome: "Jane" })).toEqual({
      ok: false,
      error: "unexpected",
    });
    expect(sanitizeTestPrintReply({ ok: "true", error: { name: "Jane" } })).toEqual({ ok: false, error: "unexpected" });
  });
});

describe("describeRelayOutput", () => {
  const line = (message: string) => `2026-10-04T00:00:00.000Z [relay] info ${message}`;

  it.each([
    ['claimed job {"jobId":"j-1","printerId":"p-1"}', "claimed job"],
    ["job sent", "job sent"],
    ['job failed {"stage":"print"}', "job failed"],
    ["job ambiguous", "job ambiguous"],
    ["job 6f1c-9a will be retried: lp failed", "job will be retried"],
    ["cloud unreachable: connect ECONNREFUSED", "cloud unreachable"],
    ["cycle failed: boom", "cycle failed"],
    ["unexpected failure: boom", "unexpected failure"],
  ])("reduces %j to %j", (message, expected) => {
    expect(describeRelayOutput(line(message))).toBe(expected);
  });

  it("withholds anything it does not recognise", () => {
    for (const message of ["Jane Q. Attendee checked in", "^XA^FDJane Q. Attendee^FS^XZ", "security code 483920", ""]) {
      expect(describeRelayOutput(line(message))).toBe("output withheld");
    }
    expect(describeRelayOutput("not even a relay line ^XA^FDJane^XZ")).toBe("output withheld");
  });

  it("drops the text after a recognised phrase", () => {
    expect(describeRelayOutput(line("cycle failed: lp said ^XA^FDJane Q. Attendee^XZ code 483920"))).toBe("cycle failed");
  });
});
