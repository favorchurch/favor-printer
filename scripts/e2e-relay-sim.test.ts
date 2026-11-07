import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without type declarations
import { assertExistingPrinterRebind, assertFreshEnrollmentRegistry, assertHandoverClaimRejected, assertJobRecordClaim, assertSpoolEmpty, DEFAULT_RSVP_DIR, resolveRsvpDir, runE2eRelaySim } from "./e2e-relay-sim.mjs";

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

  it("uses the sibling RSVP checkout when the integration checkout is absent", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "rsvp-fallback-"));
    try {
      const preferred = path.join(tmp, "rsvp-favor-printer-int");
      const fallback = path.join(tmp, "rsvp.favor.church");
      await mkdir(fallback);
      expect(resolveRsvpDir("", preferred)).toBe(fallback);
      await mkdir(preferred);
      expect(resolveRsvpDir("", preferred)).toBe(preferred);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to DEFAULT_RSVP_DIR or null if unset", () => {
    const resolved = resolveRsvpDir(undefined);
    if (resolved !== null) {
      expect([path.resolve(DEFAULT_RSVP_DIR), path.resolve(path.dirname(DEFAULT_RSVP_DIR), "rsvp.favor.church")]).toContain(resolved);
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

describe("assertFreshEnrollmentRegistry", () => {
  it("passes when exactly one relay record exists and is bound to the single matching printer", () => {
    const registry = {
      relays: [{ id: "r1", relayId: "relay-1", label: "Laptop" }],
      printers: [{ id: "p1", relayId: "relay-1", usbSerial: "ZD421-001", name: "Zebra" }],
    };
    const printer = assertFreshEnrollmentRegistry(registry, "relay-1", "ZD421-001");
    expect(printer.id).toBe("p1");
  });

  it("fails when duplicate relay records exist for the relayId", () => {
    const registry = {
      relays: [
        { id: "r1", relayId: "relay-1", label: "Laptop" },
        { id: "r2", relayId: "relay-1", label: "Laptop duplicate" },
      ],
      printers: [{ id: "p1", relayId: "relay-1", usbSerial: "ZD421-001", name: "Zebra" }],
    };
    expect(() => assertFreshEnrollmentRegistry(registry, "relay-1", "ZD421-001")).toThrow(
      /Expected exactly one registry relay record for 'relay-1', found 2/,
    );
  });

  it("fails when no relay record exists for the relayId", () => {
    const registry = {
      relays: [],
      printers: [{ id: "p1", relayId: "relay-1", usbSerial: "ZD421-001", name: "Zebra" }],
    };
    expect(() => assertFreshEnrollmentRegistry(registry, "relay-1", "ZD421-001")).toThrow(
      /Expected exactly one registry relay record for 'relay-1', found 0/,
    );
  });

  it("fails when multiple printers are bound to the relayId", () => {
    const registry = {
      relays: [{ id: "r1", relayId: "relay-1", label: "Laptop" }],
      printers: [
        { id: "p1", relayId: "relay-1", usbSerial: "ZD421-001", name: "Zebra 1" },
        { id: "p2", relayId: "relay-1", usbSerial: "ZD421-002", name: "Zebra 2" },
      ],
    };
    expect(() => assertFreshEnrollmentRegistry(registry, "relay-1", "ZD421-001")).toThrow(
      /Expected only printer 'p1' bound to relay 'relay-1', found 2/,
    );
  });

  it("fails when the printer is bound to a different relayId", () => {
    const registry = {
      relays: [{ id: "r1", relayId: "relay-1", label: "Laptop" }],
      printers: [{ id: "p1", relayId: "relay-2", usbSerial: "ZD421-001", name: "Zebra" }],
    };
    expect(() => assertFreshEnrollmentRegistry(registry, "relay-1", "ZD421-001")).toThrow(
      /Printer 'p1' is bound to relay 'relay-2', expected 'relay-1'/,
    );
  });

  it("fails when duplicate printers exist with the same serial", () => {
    const registry = {
      relays: [{ id: "r1", relayId: "relay-1", label: "Laptop" }],
      printers: [
        { id: "p1", relayId: "relay-1", usbSerial: "ZD421-001", name: "Zebra" },
        { id: "p2", relayId: "relay-1", usbSerial: "ZD421-001", name: "Zebra dup" },
      ],
    };
    expect(() => assertFreshEnrollmentRegistry(registry, "relay-1", "ZD421-001")).toThrow(
      /Expected exactly one printer with serial 'ZD421-001', found 2/,
    );
  });
});

describe("assertExistingPrinterRebind", () => {
  const basePrinter = { id: "p1", relayId: "relay-1", campusId: 7, name: "Zebra", usbSerial: "ZD421-001" };
  const baseRegistry = {
    printers: [{ ...basePrinter, relayId: "relay-2" }],
    pairedPrinter: { id: "p1" },
    jobs: [{ id: "job-1", printerId: "p1", status: "queued" }],
  };

  it("passes when rebind transfers ownership to new relay and preserves UUID, campusId, name, pairing, and backlog", () => {
    const rebound = assertExistingPrinterRebind(baseRegistry, {
      initialRelayId: "relay-1",
      joinedRelayId: "relay-2",
      originalPrinter: basePrinter,
      queuedJobId: "job-1",
    });
    expect(rebound.id).toBe("p1");
    expect(rebound.relayId).toBe("relay-2");
  });

  it("fails when joined relayId is identical to initial relayId", () => {
    expect(() =>
      assertExistingPrinterRebind(baseRegistry, {
        initialRelayId: "relay-1",
        joinedRelayId: "relay-1",
        originalPrinter: basePrinter,
        queuedJobId: "job-1",
      }),
    ).toThrow(/Expected joined relayId to differ from initial relayId 'relay-1', but got 'relay-1'/);
  });

  it("fails when joined relayId is missing", () => {
    expect(() =>
      assertExistingPrinterRebind(baseRegistry, {
        initialRelayId: "relay-1",
        joinedRelayId: "",
        originalPrinter: basePrinter,
        queuedJobId: "job-1",
      }),
    ).toThrow(/Expected joined relayId to differ from initial relayId/);
  });

  it("fails when printer is missing from registry", () => {
    expect(() =>
      assertExistingPrinterRebind(
        { ...baseRegistry, printers: [] },
        {
          initialRelayId: "relay-1",
          joinedRelayId: "relay-2",
          originalPrinter: basePrinter,
          queuedJobId: "job-1",
        },
      ),
    ).toThrow(/Printer 'p1' was not found in registry after rebind/);
  });

  it("fails when printer is not bound to joined relayId", () => {
    expect(() =>
      assertExistingPrinterRebind(
        { ...baseRegistry, printers: [{ ...basePrinter, relayId: "relay-3" }] },
        {
          initialRelayId: "relay-1",
          joinedRelayId: "relay-2",
          originalPrinter: basePrinter,
          queuedJobId: "job-1",
        },
      ),
    ).toThrow(/Rebound printer 'p1' is bound to relay 'relay-3', expected 'relay-2'/);
  });

  it("fails when printer campusId changed", () => {
    expect(() =>
      assertExistingPrinterRebind(
        { ...baseRegistry, printers: [{ ...basePrinter, relayId: "relay-2", campusId: 8 }] },
        {
          initialRelayId: "relay-1",
          joinedRelayId: "relay-2",
          originalPrinter: basePrinter,
          queuedJobId: "job-1",
        },
      ),
    ).toThrow(/Rebound printer 'p1' has campusId 8, expected 7/);
  });

  it("fails when printer name changed", () => {
    expect(() =>
      assertExistingPrinterRebind(
        { ...baseRegistry, printers: [{ ...basePrinter, relayId: "relay-2", name: "Renamed" }] },
        {
          initialRelayId: "relay-1",
          joinedRelayId: "relay-2",
          originalPrinter: basePrinter,
          queuedJobId: "job-1",
        },
      ),
    ).toThrow(/Rebound printer 'p1' has name 'Renamed', expected 'Zebra'/);
  });

  it("fails when paired printer does not match original printer ID", () => {
    expect(() =>
      assertExistingPrinterRebind(
        { ...baseRegistry, pairedPrinter: { id: "p2" } },
        {
          initialRelayId: "relay-1",
          joinedRelayId: "relay-2",
          originalPrinter: basePrinter,
          queuedJobId: "job-1",
        },
      ),
    ).toThrow(/Paired printer pointer did not resolve to 'p1', got 'p2'/);
  });

  it("fails when queued backlog job is missing or not queued", () => {
    expect(() =>
      assertExistingPrinterRebind(
        { ...baseRegistry, jobs: [{ id: "job-1", printerId: "p1", status: "sent" }] },
        {
          initialRelayId: "relay-1",
          joinedRelayId: "relay-2",
          originalPrinter: basePrinter,
          queuedJobId: "job-1",
        },
      ),
    ).toThrow(/Queued backlog job 'job-1' for printer 'p1' was not preserved in registry/);
  });
});

describe("assertHandoverClaimRejected", () => {
  it("passes when claim response status is 403 and reason is printer_handed_over", () => {
    expect(() =>
      assertHandoverClaimRejected({ status: 403, value: { reason: "printer_handed_over" } }),
    ).not.toThrow();
  });

  it("fails when claim response status is 200", () => {
    expect(() =>
      assertHandoverClaimRejected({ status: 200, value: { jobs: [] } }),
    ).toThrow(/Expected claim rejected with status 403 printer_handed_over, got status 200/);
  });

  it("fails when reason is not printer_handed_over", () => {
    expect(() =>
      assertHandoverClaimRejected({ status: 403, value: { reason: "unauthorized" } }),
    ).toThrow(/Expected claim rejected with status 403 printer_handed_over, got status 403: {"reason":"unauthorized"}/);
  });

  it("fails when claim response is null", () => {
    expect(() => assertHandoverClaimRejected(null)).toThrow("Claim response was not returned");
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
      expect(result.claimedBy).toMatch(/^relay-/);
      expect(result.labelsReceived).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});
