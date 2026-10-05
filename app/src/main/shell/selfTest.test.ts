import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseParentMessage } from "../../../../vendor/relay/embeddedProtocol";
import { createFakeTimers } from "../services/testing/fakes";
import { parseSelfTestArg, runSelfTest, SELF_TEST_IDENTITY, SELF_TEST_QUEUE } from "./selfTest";
import { createForkHarness, fireTimer, relayStatus } from "./testing/fakeChild";

describe("parseSelfTestArg", () => {
  it("is not self-test mode without the flag", () => {
    expect(parseSelfTestArg(["/Applications/Favor Printer.app/Contents/MacOS/Favor Printer"])).toEqual({ kind: "none" });
    expect(parseSelfTestArg([])).toEqual({ kind: "none" });
  });

  it.each([
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
    ["http://localhost:9000", "http://localhost:9000"],
    ["http://[::1]:7000", "http://[::1]:7000"],
  ])("accepts the loopback URL %s", (url, apiUrl) => {
    expect(parseSelfTestArg(["app", `--self-test-relay=${url}`])).toEqual({ kind: "run", apiUrl });
  });

  it.each([
    ["https://127.0.0.1:8080", "must be http"],
    ["http://127.0.0.1", "needs a port"],
    ["http://127.0.0.1.evil.example:8080", "loopback"],
    ["http://localhost.evil.example:8080", "loopback"],
    ["http://evil.example:8080", "loopback"],
    ["http://0.0.0.0:8080", "loopback"],
    ["http://10.0.0.5:8080", "loopback"],
    ["http://192.168.1.10:8080", "loopback"],
    ["http://rsvp.favor.church:8080", "loopback"],
    ["http://user:pass@127.0.0.1:8080", "credentials"],
    ["http://127.0.0.1:8080/api", "origin only"],
    ["http://127.0.0.1:8080/?x=1", "origin only"],
    ["http://127.0.0.1:8080/#x", "origin only"],
    ["ftp://127.0.0.1:8080", "must be http"],
    ["127.0.0.1:8080", "not a URL"],
    ["", "not a URL"],
    ["not a url", "not a URL"],
  ])("rejects %j", (url, reason) => {
    const result = parseSelfTestArg([`--self-test-relay=${url}`]);
    expect(result.kind).toBe("invalid");
    expect((result as { reason: string }).reason).toContain(reason);
  });
});

function setup(overrides: { timeoutMs?: number } = {}) {
  const harness = createForkHarness();
  const timers = createFakeTimers();
  const run = runSelfTest({
    apiUrl: "http://127.0.0.1:8080",
    fork: harness.fork,
    workDir: "/tmp/self-test",
    appVersion: "0.1.0",
    osVersion: "macOS 15",
    timers: timers.timers,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    tuning: { stopWaitMs: 100, inFlightCeilingMs: 300 },
  });
  return { ...harness, timers, run };
}

describe("runSelfTest", () => {
  it("forks the relay, waits for running with the cloud ok, stops it and reports success", async () => {
    const { children, last, run } = setup();
    await vi.waitFor(() => expect(children).toHaveLength(1));

    last().emitMessage({ type: "event", event: relayStatus({ state: "starting", cloud: "unreachable" }) });
    expect(last().types()).toEqual(["start"]);

    last().emitMessage({ type: "event", event: relayStatus({ state: "running", cloud: "ok" }) });
    await vi.waitFor(() => expect(last().types()).toEqual(["start", "stop"]));
    last().emitMessage({ type: "stopped" });
    last().emitExit(0);

    await expect(run).resolves.toEqual({ type: "self-test", ok: true, running: true, cloud: "ok", stopOutcome: "stopped" });
  });

  it("starts the relay with the fixed test identity against the stub cloud, inside the work folder", async () => {
    const { children, last, run } = setup();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const start = parseParentMessage(last().messages[0]);
    expect(start).toEqual({
      type: "start",
      options: {
        apiUrl: "http://127.0.0.1:8080",
        relayId: SELF_TEST_IDENTITY.relayId,
        token: SELF_TEST_IDENTITY.token,
        spoolDir: path.join(path.resolve("/tmp/self-test"), "spool"),
        transport: { kind: "cups", queue: SELF_TEST_QUEUE },
        appVersion: "0.1.0",
        osVersion: "macOS 15",
        printerAttached: false,
      },
    });
    last().emitMessage({ type: "event", event: relayStatus() });
    await vi.waitFor(() => expect(last().types()).toContain("stop"));
    last().emitMessage({ type: "stopped" });
    await run;
  });

  it("is a failure when the relay never gets to running with the cloud ok, but still stops it", async () => {
    const { children, last, timers, run } = setup();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    last().emitMessage({ type: "event", event: relayStatus({ state: "running", cloud: "unreachable" }) });

    fireTimer(timers, 5_000);
    await vi.waitFor(() => expect(last().types()).toContain("stop"));
    last().emitMessage({ type: "stopped" });

    await expect(run).resolves.toMatchObject({ ok: false, running: false, error: "timeout", cloud: "unreachable" });
  });

  it("is a failure when the child exits without saying stopped", async () => {
    const { children, last, run } = setup();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    last().emitMessage({ type: "event", event: relayStatus() });
    await vi.waitFor(() => expect(last().types()).toContain("stop"));
    last().emitExit(0);

    await expect(run).resolves.toMatchObject({ ok: false, running: true, error: "stop_failed" });
  });

  it("reports one JSON-serialisable result with fixed fields only", async () => {
    const { children, last, run } = setup();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    last().emitMessage({ type: "event", event: relayStatus() });
    await vi.waitFor(() => expect(last().types()).toContain("stop"));
    last().emitMessage({ type: "stopped" });

    const line = JSON.stringify(await run);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ type: "self-test", ok: true });
    expect(line).not.toContain(SELF_TEST_IDENTITY.token);
  });
});
