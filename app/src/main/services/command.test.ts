import { accessSync, constants } from "node:fs";
import { describe, expect, it } from "vitest";

import { BINARIES, createCommandRunner, type ExecFile } from "./command";

type Callback = Parameters<ExecFile>[3];

function fakeExecFile(respond: (callback: Callback) => void) {
  const calls: Array<{ file: string; args: unknown; options: Record<string, unknown> }> = [];
  const impl: ExecFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    respond(callback);
    return undefined;
  };
  return { impl, calls };
}

describe("createCommandRunner", () => {
  it("runs the file with an argument array and no shell", async () => {
    const { impl, calls } = fakeExecFile((callback) => callback(null, "out", "err"));
    const run = createCommandRunner(impl);

    const result = await run("/usr/bin/lpstat", ["-p", "Zebra; rm -rf /"], { timeoutMs: 1234 });

    expect(result).toEqual({ code: 0, stdout: "out", stderr: "err", timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("/usr/bin/lpstat");
    // The argument stays one array element: nothing joins or parses it.
    expect(calls[0].args).toEqual(["-p", "Zebra; rm -rf /"]);
    expect(calls[0].options).toMatchObject({ timeout: 1234, encoding: "utf8" });
    expect(calls[0].options).not.toHaveProperty("shell");
  });

  it("uses a default timeout when none is given", async () => {
    const { impl, calls } = fakeExecFile((callback) => callback(null, "", ""));
    await createCommandRunner(impl)("/bin/launchctl", []);
    expect(calls[0].options.timeout).toBeGreaterThan(0);
  });

  it("returns a non-zero exit as data", async () => {
    const { impl } = fakeExecFile((callback) =>
      callback(Object.assign(new Error("Command failed"), { code: 1 }), "", "lpadmin: Unauthorized"),
    );
    const result = await createCommandRunner(impl)("/usr/sbin/lpadmin", ["-p", "x"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "lpadmin: Unauthorized", timedOut: false });
  });

  it("returns a process that could not start with no exit code", async () => {
    const { impl } = fakeExecFile((callback) =>
      callback(Object.assign(new Error("spawn /usr/bin/lpinfo ENOENT"), { code: "ENOENT" }), "", ""),
    );
    const result = await createCommandRunner(impl)("/usr/bin/lpinfo", ["-v"]);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("ENOENT");
    expect(result.timedOut).toBe(false);
  });

  it("reports a killed process as timed out", async () => {
    const { impl } = fakeExecFile((callback) =>
      callback(Object.assign(new Error("timed out"), { killed: true, code: null }), "partial", ""),
    );
    const result = await createCommandRunner(impl)("/usr/bin/lpinfo", ["-v"]);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe("partial");
  });

  it("never rejects when execFile throws", async () => {
    const impl: ExecFile = () => {
      throw new Error("bad arguments");
    };
    const result = await createCommandRunner(impl)("/usr/bin/lpinfo", ["-v"]);
    expect(result).toEqual({ code: null, stdout: "", stderr: "bad arguments", timedOut: false });
  });
});

describe("BINARIES", () => {
  it("are absolute paths", () => {
    for (const file of Object.values(BINARIES)) expect(file).toMatch(/^\/[^\s]+$/);
  });

  // A wrong path fails only at runtime as ENOENT ("could not look for printers"), which the
  // adapter-injected service tests cannot see. Check the real files on the macOS hosts we ship to.
  it.runIf(process.platform === "darwin")("exist and are executable on macOS", () => {
    for (const file of Object.values(BINARIES)) {
      expect(() => accessSync(file, constants.X_OK), file).not.toThrow();
    }
  });
});
