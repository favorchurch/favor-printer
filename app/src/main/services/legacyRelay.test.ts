import { describe, expect, it } from "vitest";

import { BINARIES } from "./command";
import { createLegacyRelay, legacyPlistPath } from "./legacyRelay";
import { expectArgvOnly, fail, ok, scriptedRunner, type RecordedCall } from "./testing/fakes";

const HOME = "/Users/volunteer";
const UID = 501;
const TARGET = "gui/501/church.favor.printrelay";
/** What launchd answers for a label it does not know. */
const NOT_FOUND = fail(113, 'Could not find service "church.favor.printrelay" in domain for user gui: 501');
const PLIST = "/Users/volunteer/Library/LaunchAgents/church.favor.printrelay.plist";

/** launchctl subcommand -> result. `print` defaults to "not loaded" (exit 113). */
function setup(
  answers: Partial<Record<"print" | "bootout" | "disable", ReturnType<typeof ok> | Array<ReturnType<typeof ok>>>> = {},
  plistPresent = true,
) {
  const queues = new Map<string, Array<ReturnType<typeof ok>>>();
  for (const [name, answer] of Object.entries(answers)) queues.set(name, Array.isArray(answer) ? [...answer] : [answer]);
  const existsCalls: string[] = [];

  const { run, calls } = scriptedRunner((file, args) => {
    if (file !== BINARIES.launchctl) throw new Error(`unexpected binary ${file}`);
    const queue = queues.get(args[0]);
    // The last answer repeats, so one entry covers any number of calls.
    const answer = queue && (queue.length > 1 ? queue.shift() : queue[0]);
    if (answer) return answer;
    return args[0] === "print" ? NOT_FOUND : ok();
  });

  const legacy = createLegacyRelay({
    run,
    homeDir: HOME,
    uid: UID,
    fileExists: async (file) => {
      existsCalls.push(file);
      return plistPresent;
    },
  });
  return { legacy, calls, existsCalls };
}

const subcommands = (calls: readonly RecordedCall[]) => calls.map((call) => call.args[0]);

describe("detect", () => {
  it("asks launchctl about the label with argv", async () => {
    const { legacy, calls } = setup();
    await legacy.detect();
    expect(calls).toEqual([{ file: BINARIES.launchctl, args: ["print", TARGET] }]);
    expectArgvOnly(calls);
  });

  it("looks for the plist in LaunchAgents and nowhere else", async () => {
    const { legacy, existsCalls } = setup();
    await legacy.detect();
    expect(existsCalls).toEqual([PLIST]);
    expect(legacyPlistPath(HOME)).toBe(PLIST);
  });

  it("reports a loaded agent", async () => {
    const { legacy } = setup({ print: ok("state = running") });
    expect(await legacy.detect()).toEqual({ plistPresent: true, loaded: true });
  });

  it("reports an agent launchd does not know, with or without the plist", async () => {
    expect(await setup({ print: NOT_FOUND }, true).legacy.detect()).toEqual({ plistPresent: true, loaded: false });
    expect(await setup({ print: NOT_FOUND }, false).legacy.detect()).toEqual({ plistPresent: false, loaded: false });
  });

  it("assumes loaded when launchctl cannot be asked", async () => {
    expect((await setup({ print: fail(null, "spawn ENOENT") }).legacy.detect()).loaded).toBe(true);
    expect((await setup({ print: fail(null, "", true) }).legacy.detect()).loaded).toBe(true);
  });
});

describe("detect fails closed", () => {
  it.each([
    ["exit 113 with other text", fail(113, "something else went wrong")],
    ["exit 113 with no text", fail(113)],
    ["another non-zero exit", fail(1, "Could not find service")],
    ["permission error", fail(2, "Operation not permitted")],
    ["could not be started", fail(null, "spawn ENOENT")],
    ["timed out", fail(113, 'Could not find service "x"', true)],
    ["no exit code even with the not-found text", fail(null, 'Could not find service "x"')],
  ])("treats %s as loaded", async (_name, print) => {
    const { legacy } = setup({ print });
    expect((await legacy.detect()).loaded).toBe(true);
    expect(await legacy.canStartRelay()).toEqual({ allowed: false, reason: "legacy_loaded" });
  });

  it("treats only the known not-found answer as not loaded", async () => {
    const { legacy } = setup({ print: NOT_FOUND });
    expect((await legacy.detect()).loaded).toBe(false);
    expect(await legacy.canStartRelay()).toEqual({ allowed: true });
  });

  it("reads the not-found text from stdout too", async () => {
    const { legacy } = setup({ print: { code: 113, stdout: 'Could not find service "x"', stderr: "", timedOut: false } });
    expect((await legacy.detect()).loaded).toBe(false);
  });

  it("fails closed in the check after a failed bootout when the answer is not the known one", async () => {
    for (const print of [fail(1, "launchctl: odd failure"), fail(113, "odd"), fail(null, "spawn ENOENT")]) {
      const { legacy, calls } = setup({ bootout: fail(5), print });
      expect(await legacy.migrate()).toEqual({ ok: false, reason: "bootout_failed" });
      expect(subcommands(calls)).toEqual(["bootout", "print"]);
      expect(await legacy.canStartRelay()).toEqual({ allowed: false, reason: "bootout_failed" });
    }
  });
});

describe("migrate", () => {
  it("boots the agent out, then disables it, as argv", async () => {
    const { legacy, calls } = setup({ print: ok("state = running") });
    expect(await legacy.migrate()).toEqual({ ok: true });
    expect(calls).toEqual([
      { file: BINARIES.launchctl, args: ["bootout", TARGET] },
      { file: BINARIES.launchctl, args: ["disable", TARGET] },
    ]);
    expectArgvOnly(calls);
  });

  it("fails with bootout_failed and does not disable when the agent is still loaded", async () => {
    const { legacy, calls } = setup({ bootout: fail(5, "Boot-out failed: 5: Input/output error"), print: ok("state = running") });
    expect(await legacy.migrate()).toEqual({ ok: false, reason: "bootout_failed" });
    expect(subcommands(calls)).toEqual(["bootout", "print"]);
  });

  it("fails with bootout_failed when launchctl cannot be asked afterwards", async () => {
    const { legacy } = setup({ bootout: fail(1), print: fail(null, "spawn ENOENT") });
    expect(await legacy.migrate()).toEqual({ ok: false, reason: "bootout_failed" });
  });

  it("counts an agent that was already gone as booted out, and still disables it", async () => {
    const { legacy, calls } = setup({ bootout: fail(3, "No such process"), print: NOT_FOUND });
    expect(await legacy.migrate()).toEqual({ ok: true });
    expect(subcommands(calls)).toEqual(["bootout", "print", "disable"]);
  });

  it("fails with disable_failed when disable fails", async () => {
    const { legacy, calls } = setup({ disable: fail(1, "Could not disable") });
    expect(await legacy.migrate()).toEqual({ ok: false, reason: "disable_failed" });
    expect(subcommands(calls)).toEqual(["bootout", "disable"]);
  });

  it("never reads the old plist or relay.env", async () => {
    const { legacy, calls, existsCalls } = setup({ print: ok("state = running") });
    await legacy.detect();
    await legacy.migrate();
    await legacy.canStartRelay();

    expect(existsCalls.every((file) => file === PLIST)).toBe(true);
    for (const call of calls) {
      expect(call.file).toBe(BINARIES.launchctl);
      expect(["print", "bootout", "disable"]).toContain(call.args[0]);
      expect(call.args.join(" ")).not.toMatch(/relay\.env|\.plist|\bcat\b|plutil/);
    }
  });
});

describe("canStartRelay", () => {
  it("allows the relay when the legacy agent is not loaded", async () => {
    expect(await setup({ print: NOT_FOUND }).legacy.canStartRelay()).toEqual({ allowed: true });
  });

  it("refuses while the legacy agent is loaded", async () => {
    expect(await setup({ print: ok("state = running") }).legacy.canStartRelay()).toEqual({
      allowed: false,
      reason: "legacy_loaded",
    });
  });

  it("refuses when launchctl cannot be asked", async () => {
    expect(await setup({ print: fail(null, "spawn ENOENT") }).legacy.canStartRelay()).toEqual({
      allowed: false,
      reason: "legacy_loaded",
    });
  });

  it("refuses after a failed bootout even if the agent later looks gone", async () => {
    const { legacy } = setup({ bootout: fail(5), print: [ok("state = running"), NOT_FOUND] });
    await legacy.migrate();
    expect(await legacy.canStartRelay()).toEqual({ allowed: false, reason: "bootout_failed" });
  });

  it("refuses after a failed disable, because the agent would load again at login", async () => {
    const { legacy } = setup({ disable: fail(1) });
    await legacy.migrate();
    expect(await legacy.canStartRelay()).toEqual({ allowed: false, reason: "disable_failed" });
  });

  it("allows the relay again once a retry completes both steps", async () => {
    const { legacy } = setup({ disable: [fail(1), ok()] });
    expect(await legacy.migrate()).toEqual({ ok: false, reason: "disable_failed" });
    expect(await legacy.migrate()).toEqual({ ok: true });
    expect(await legacy.canStartRelay()).toEqual({ allowed: true });
  });

  it("allows the relay after a successful migration", async () => {
    // launchd reports the agent loaded before the migration and unknown after it.
    const { legacy } = setup({ print: [ok("state = running"), NOT_FOUND] });
    expect((await legacy.detect()).loaded).toBe(true);
    expect(await legacy.migrate()).toEqual({ ok: true });
    expect(await legacy.canStartRelay()).toEqual({ allowed: true });
  });
});
