import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without type declarations
import { assertJobRecordClaim, assertSpoolEmpty, DEFAULT_RSVP_DIR, resolveRsvpDir, runE2eRelaySim } from "./e2e-relay-sim.mjs";

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
  const script = readFileSync(path.join(__dirname, "smoke-packaged.sh"), "utf8");

  it("runs its JS helpers with the packaged binary, never a bare node", () => {
    expect(script).not.toMatch(/(^|[\s$(])node\s+-e/m);
  });
});

describe("harness-server.ts", () => {
  it("serves relay config from the real handlers, with no fabricated fallback", () => {
    const source = readFileSync(path.join(__dirname, "..", "e2e", "harness-server.ts"), "utf8");
    expect(source).not.toMatch(/relay\/config/);
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
