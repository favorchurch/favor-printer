import { describe, expect, it } from "vitest";

import type { CommandOptions, CommandResult, CommandRunner } from "./command";
import { BINARIES } from "./command";
import { CALIBRATE_PAYLOAD, createPrinterSetup, MODE_PAYLOAD, SAVE_PAYLOAD } from "./printerSetup";
import { expectArgvOnly, fail, ok } from "./testing/fakes";

type Call = { file: string; args: readonly string[]; input: string | undefined };

/** A fake runner: never starts a process. `reply` decides each call's result. */
function fakeRunner(reply: (call: Call, index: number) => CommandResult | Promise<CommandResult> = () => ok()) {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, options?: CommandOptions) => {
    const call = { file, args: [...args], input: options?.input };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return { run, calls };
}

describe("printer setup", () => {
  it("sends mode, calibrate, then save as three separate raw jobs to the queue", async () => {
    const { run, calls } = fakeRunner();
    const result = await createPrinterSetup({ run }).run("Favor_S1");

    expect(result).toEqual({ ok: true });
    expect(calls.map((call) => call.input)).toEqual([MODE_PAYLOAD, CALIBRATE_PAYLOAD, SAVE_PAYLOAD]);
    for (const call of calls) {
      expect(call.file).toBe(BINARIES.lp);
      expect(call.args).toEqual(["-d", "Favor_S1", "-o", "raw"]);
    }
    expectArgvOnly(calls);
  });

  it("keeps the immediate calibrate command out of the mode and save streams", () => {
    expect(MODE_PAYLOAD).toContain("^MMC");
    expect(MODE_PAYLOAD).not.toContain("~JC");
    expect(CALIBRATE_PAYLOAD).toContain("~JC");
    expect(CALIBRATE_PAYLOAD).not.toContain("^");
    expect(SAVE_PAYLOAD).not.toContain("~JC");
  });

  it("waits for each job to finish before it sends the next", async () => {
    let active = 0;
    let overlapped = false;
    const { run } = fakeRunner(async () => {
      active++;
      overlapped ||= active > 1;
      await Promise.resolve();
      active--;
      return ok();
    });
    await createPrinterSetup({ run }).run("Q");
    expect(overlapped).toBe(false);
  });

  it.each([
    [0, "mode"],
    [1, "calibrate"],
    [2, "save"],
  ] as const)("stops at the first failed step (%i) and reports %s", async (failAt, step) => {
    const { run, calls } = fakeRunner((_call, index) => (index === failAt ? fail(1, "lp: error") : ok()));
    const result = await createPrinterSetup({ run }).run("Q");

    expect(result).toEqual({ ok: false, reason: "failed", step });
    expect(calls).toHaveLength(failAt + 1);
  });

  it("counts a command that could not start or timed out as a failure", async () => {
    for (const bad of [fail(null, "spawn ENOENT"), fail(null, "", true)]) {
      const { run, calls } = fakeRunner(() => bad);
      expect(await createPrinterSetup({ run }).run("Q")).toEqual({ ok: false, reason: "failed", step: "mode" });
      expect(calls).toHaveLength(1);
    }
  });

  it("returns no-queue and spawns nothing without a queue", async () => {
    const { run, calls } = fakeRunner();
    const setup = createPrinterSetup({ run });
    expect(await setup.run(null)).toEqual({ ok: false, reason: "no-queue" });
    expect(await setup.run("")).toEqual({ ok: false, reason: "no-queue" });
    expect(calls).toHaveLength(0);
  });

  it("returns busy for a second call while one runs, and spawns nothing for it", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { run, calls } = fakeRunner(async (_call, index) => {
      if (index === 0) await gate;
      return ok();
    });
    const setup = createPrinterSetup({ run });

    const first = setup.run("Q");
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(await setup.run("Q")).toEqual({ ok: false, reason: "busy" });
    expect(calls).toHaveLength(1);

    release?.();
    expect(await first).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("can run again after a failure", async () => {
    let failing = true;
    const { run } = fakeRunner(() => (failing ? fail(1) : ok()));
    const setup = createPrinterSetup({ run });
    expect(await setup.run("Q")).toMatchObject({ ok: false, reason: "failed" });
    failing = false;
    expect(await setup.run("Q")).toEqual({ ok: true });
  });

  it("can run again after the runner rejects", async () => {
    let rejecting = true;
    const { run } = fakeRunner(() => {
      if (rejecting) throw new Error("boom");
      return ok();
    });
    const setup = createPrinterSetup({ run });
    await expect(setup.run("Q")).rejects.toThrow("boom");
    rejecting = false;
    expect(await setup.run("Q")).toEqual({ ok: true });
  });
});
