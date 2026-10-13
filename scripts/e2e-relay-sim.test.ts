import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without type declarations
import { assertJobRecordClaim, assertSpoolEmpty, DEFAULT_RSVP_DIR, resolveRsvpDir, runE2eRelaySim } from "./e2e-relay-sim.mjs";

const execFileAsync = promisify(execFile);

describe("resolveRsvpDir", () => {
  it("resolves an explicit existing directory", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "rsvp-test-"));
    try {
      expect(resolveRsvpDir(tmp)).toBe(path.resolve(tmp));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws when explicitly passed a nonexistent directory", () => {
    expect(() => resolveRsvpDir("/nonexistent/path/that/cannot/exist")).toThrow(
      /RSVP_DIR was explicitly set to .* but that directory does not exist/,
    );
  });

  it("falls back to DEFAULT_RSVP_DIR or null if unset", () => {
    const resolved = resolveRsvpDir(undefined);
    if (resolved !== null) {
      expect(resolved).toBe(path.resolve(DEFAULT_RSVP_DIR));
    } else {
      expect(resolved).toBeNull();
    }
  });
});

describe("assertJobRecordClaim", () => {
  it("passes when job.claimedBy matches the expected Favor Printer relay id", () => {
    expect(() =>
      assertJobRecordClaim(
        { id: "job-1", status: "sent", claimedBy: "relay-a" },
        "relay-a",
      ),
    ).not.toThrow();
  });

  it("passes when job.claimed_by matches (snake_case from DB)", () => {
    expect(() =>
      assertJobRecordClaim(
        { id: "job-1", status: "sent", claimed_by: "relay-a" },
        "relay-a",
      ),
    ).not.toThrow();
  });

  it("fails when job is null or missing", () => {
    expect(() => assertJobRecordClaim(null, "relay-a")).toThrow(
      "Job was not found in server job store",
    );
  });

  it("fails when job has no claim", () => {
    expect(() =>
      assertJobRecordClaim({ id: "job-1", status: "queued", claimedBy: null }, "relay-a"),
    ).toThrow(/Job job-1 was not claimed/);
  });

  it("fails when job was claimed by a helper relay or different relay", () => {
    expect(() =>
      assertJobRecordClaim(
        { id: "job-1", status: "sent", claimedBy: "helper-relay" },
        "relay-a",
      ),
    ).toThrow(/claimed by 'helper-relay', expected 'relay-a'/);
  });
});

describe("assertSpoolEmpty", () => {
  let spoolDir: string;

  beforeEach(async () => {
    spoolDir = await mkdtemp(path.join(os.tmpdir(), "spool-test-"));
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it("passes when spool directory is empty", async () => {
    await expect(assertSpoolEmpty(spoolDir)).resolves.toBeUndefined();
  });

  it("passes when spool directory does not exist yet", async () => {
    await expect(
      assertSpoolEmpty(path.join(spoolDir, "does-not-exist")),
    ).resolves.toBeUndefined();
  });

  it("fails when the spool directory must exist but was never created", async () => {
    let thrown: unknown;
    try {
      await assertSpoolEmpty(path.join(spoolDir, "does-not-exist"), { mustExist: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/was never created/);
    expect((thrown as { cause?: { code?: string } }).cause?.code).toBe("ENOENT");
  });

  it("passes an existing empty spool directory when it must exist", async () => {
    await expect(assertSpoolEmpty(spoolDir, { mustExist: true })).resolves.toBeUndefined();
  });

  it("fails when leftover .zpl file is in spool", async () => {
    await writeFile(path.join(spoolDir, "0001.zpl"), "^XA^FDLabel^FS^XZ");
    await expect(assertSpoolEmpty(spoolDir)).rejects.toThrow(
      /Spool contains unhandled job files after report: 0001.zpl/,
    );
  });

  it("fails when leftover .send in-flight marker is in spool", async () => {
    await writeFile(path.join(spoolDir, "job-1.send"), "sending");
    await expect(assertSpoolEmpty(spoolDir)).rejects.toThrow(
      /Spool contains unhandled job files after report: job-1.send/,
    );
  });

  it("fails when leftover .json job file is in spool", async () => {
    await writeFile(path.join(spoolDir, "job-1.json"), "{}");
    await expect(assertSpoolEmpty(spoolDir)).rejects.toThrow(
      /Spool contains unhandled job files after report: job-1.json/,
    );
  });

  it("fails when file contents contain raw ZPL (^XA...^XZ)", async () => {
    await writeFile(path.join(spoolDir, "leak.txt"), "some raw payload ^XA^FDdata^FS^XZ");
    await expect(assertSpoolEmpty(spoolDir)).rejects.toThrow(
      /Spool file leak.txt contains raw ZPL after report/,
    );
  });
});

describe("smoke-packaged.sh", () => {
  it("uses the packaged binary for its runtime checks and reports the self-test", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "favor-printer-smoke-test-"));
    const app = path.join(temp, "Favor Printer.app");
    const contents = path.join(app, "Contents");
    const fakeBin = path.join(temp, "bin");
    const executable = path.join(contents, "MacOS", "Favor Printer");
    const calls = path.join(temp, "binary-calls.txt");
    const executableScript = `#!/bin/sh
printf '%s %s\\n' "$1" "$3" >> "$SMOKE_BINARY_CALLS"
if [ "$1" = "-e" ]; then
  exec ${JSON.stringify(process.execPath)} -e "$2" "$3"
fi
case "$1" in
  --self-test-relay=*) printf '%s\\n' '{"type":"self-test","ok":true,"running":true,"cloud":"ok","stopOutcome":"stopped"}' ;;
  *) exit 1 ;;
esac
`;
    try {
      await mkdir(path.join(contents, "Resources", "app", "dist"), { recursive: true });
      await mkdir(path.dirname(executable), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(path.join(contents, "Info.plist"), "test fixture");
      await writeFile(path.join(contents, "Resources", "app", "dist", "relay.js"), "// bundled relay");
      await writeFile(executable, executableScript);
      await chmod(executable, 0o755);
      await writeFile(
        path.join(fakeBin, "plutil"),
        '#!/bin/sh\ncase "$2" in\n  CFBundleExecutable) echo "Favor Printer" ;;\n  CFBundleIdentifier) echo "church.favor.printer" ;;\n  CFBundleShortVersionString) echo "0.1.0" ;;\n  *) exit 1 ;;\nesac\n',
      );
      await chmod(path.join(fakeBin, "plutil"), 0o755);

      const { stdout } = await execFileAsync("bash", [path.join(__dirname, "smoke-packaged.sh"), app], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, SMOKE_BINARY_CALLS: calls },
        timeout: 20_000,
      });
      const binaryCalls = await readFile(calls, "utf8");
      expect(stdout).toContain("0 failed");
      expect(binaryCalls).toContain("-e");
      expect(binaryCalls).toContain("/port.txt");
      expect(binaryCalls).toContain("--self-test-relay=http://127.0.0.1:");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe("runE2eRelaySim live integration", () => {
  // Only runs when explicitly requested via RUN_LIVE_E2E=1 or during integration testing.
  // In ordinary unit test runs, this is skipped per the run directive:
  // "write the e2e and smoke scripts and their tests, but do not run them. They run at integration against /Users/rico/Git/rsvp-favor-printer-int..."
  it.skipIf(!process.env.RUN_LIVE_E2E)(
    "proves claim -> send -> report and revoked (401) against live RSVP checkout",
    async () => {
      const result = await runE2eRelaySim();
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.claimedBy).toBe("relay-a");
      expect(result.labelsReceived).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});
