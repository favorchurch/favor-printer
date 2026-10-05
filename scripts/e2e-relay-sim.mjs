#!/usr/bin/env node
/**
 * End-to-end test against RSVP relay:sim (fake Zebra TCP sink + inspect endpoint)
 * and the RSVP cloud relay API.
 *
 * Verifies:
 * 1. The bundled relay (dist/relay.js) starts via Electron with ELECTRON_RUN_AS_NODE=1,
 *    configured via the app's relayConfig builder with tcp transport.
 * 2. Claim -> send -> report: a queued check-in job is claimed, its ZPL sent to the
 *    relay:sim fake Zebra sink, and reported as 'sent'.
 * 3. The fixture job's claim belongs to the Favor Printer relay id (asserted on
 *    the server's job record, e.g. claimedBy), NEVER a helper relay.
 * 4. The spool directory is verified empty of ZPL and payload files after report.
 * 5. A revoked (401) relay run yields the revoked cloud status event.
 */

import { fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import electronPath from "electron";
import { build as esbuild } from "esbuild";

import { buildApp } from "./build.mjs";

export const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_RSVP_DIR = "/Users/rico/Git/rsvp-favor-printer-int";

/**
 * Resolves the RSVP checkout directory.
 * If RSVP_DIR is explicitly passed/set, it must exist.
 * Otherwise, checks DEFAULT_RSVP_DIR. Returns null if neither is available.
 */
export function resolveRsvpDir(customDir = process.env.RSVP_DIR) {
  if (customDir) {
    const resolved = path.resolve(customDir);
    if (existsSync(resolved)) return resolved;
    throw new Error(`RSVP_DIR was explicitly set to '${customDir}', but that directory does not exist.`);
  }
  if (existsSync(DEFAULT_RSVP_DIR)) {
    return path.resolve(DEFAULT_RSVP_DIR);
  }
  return null;
}

/**
 * Asserts that the server's job record belongs to the Favor Printer relay ID,
 * never a helper relay or an unclaimed state.
 */
export function assertJobRecordClaim(job, expectedRelayId) {
  if (!job) {
    throw new Error("Job was not found in server job store");
  }
  const claimedBy = job.claimedBy ?? job.claimed_by;
  if (!claimedBy) {
    throw new Error(`Job ${job.id} was not claimed (status: ${job.status})`);
  }
  if (claimedBy !== expectedRelayId) {
    throw new Error(
      `Job ${job.id} claimed by '${claimedBy}', expected '${expectedRelayId}'. Must belong to the Favor Printer relay ID, never a helper relay.`,
    );
  }
}

/**
 * Asserts that the spool directory has no leftover .zpl, .send, or .json files,
 * and no file containing ZPL payload content after reporting.
 */
export async function assertSpoolEmpty(spoolDir, { mustExist = false } = {}) {
  let names;
  try {
    names = await readdir(spoolDir);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      if (mustExist) {
        throw new Error(`Spool directory ${spoolDir} was never created, so an empty spool proves nothing`, { cause: err });
      }
      return;
    }
    throw err;
  }
  const leftovers = names.filter(
    (n) => n.endsWith(".zpl") || n.endsWith(".send") || n.endsWith(".json"),
  );
  if (leftovers.length > 0) {
    throw new Error(`Spool contains unhandled job files after report: ${leftovers.join(", ")}`);
  }
  for (const name of names) {
    const full = path.join(spoolDir, name);
    let content;
    try {
      content = await readFile(full, "utf8");
    } catch {
      continue;
    }
    if (content.includes("^XA") || content.includes("^XZ")) {
      throw new Error(`Spool file ${name} contains raw ZPL after report`);
    }
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, description, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // Keep waiting
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
}

/**
 * Dynamically loads buildRelayStartOptions from app/src/main/services/relayConfig.ts
 */
export async function loadRelayConfigBuilder(root = defaultRepoRoot) {
  const bundle = await esbuild({
    absWorkingDir: root,
    entryPoints: [path.join(root, "app/src/main/services/relayConfig.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  const code = bundle.outputFiles[0].text;
  const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const mod = await import(dataUri);
  return mod.buildRelayStartOptions;
}

/**
 * Runs the complete end-to-end relay simulation test.
 */
export async function runE2eRelaySim(options = {}) {
  const root = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const rsvpDir = resolveRsvpDir(options.rsvpDir);

  if (!rsvpDir) {
    const reason = `RSVP_DIR is unset and default '${DEFAULT_RSVP_DIR}' does not exist`;
    return { ok: true, skipped: true, reason };
  }

  // Ensure bundled relay exists
  const relayJsPath = path.join(root, "dist/relay.js");
  if (!existsSync(relayJsPath)) {
    console.log("[e2e-relay-sim] dist/relay.js not found, building app...");
    await buildApp({ root });
  }
  if (!existsSync(relayJsPath)) {
    throw new Error("Failed to produce dist/relay.js");
  }

  const electronBin =
    typeof electronPath === "string" ? electronPath : electronPath.default || electronPath;
  if (!electronBin || !existsSync(electronBin)) {
    throw new Error(`Electron binary not found at '${electronBin}'`);
  }

  const tsxCli = path.join(rsvpDir, "node_modules/tsx/dist/cli.mjs");
  if (!existsSync(tsxCli)) {
    throw new Error(`tsx CLI not found at '${tsxCli}' in RSVP checkout`);
  }

  const cleanupTasks = [];
  const runCleanup = async () => {
    while (cleanupTasks.length > 0) {
      const task = cleanupTasks.pop();
      try {
        await task();
      } catch (err) {
        console.error("[e2e-relay-sim] cleanup error:", err);
      }
    }
  };

  try {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "favor-e2e-"));
    cleanupTasks.push(() => rm(tempDir, { recursive: true, force: true }));

    const sinkPort = await freePort();
    const inspectPort = await freePort();
    const simRecordDir = path.join(tempDir, "sim-received");
    await mkdir(simRecordDir, { recursive: true });

    console.log(`[e2e-relay-sim] starting relay:sim in sink-only mode (sink: ${sinkPort}, inspect: ${inspectPort})...`);
    const simProcess = spawn(
      process.execPath,
      [tsxCli, path.join(rsvpDir, "relay/simulate.ts")],
      {
        cwd: rsvpDir,
        env: {
          ...process.env,
          SIM_SINK_ONLY: "1",
          SIM_SINK_PORT: String(sinkPort),
          SIM_INSPECT_PORT: String(inspectPort),
          SIM_RECORD_DIR: simRecordDir,
        },
        stdio: "ignore",
      },
    );
    cleanupTasks.push(async () => {
      if (simProcess.exitCode === null && simProcess.signalCode === null) {
        simProcess.kill("SIGTERM");
      }
    });

    const inspectUrl = `http://127.0.0.1:${inspectPort}/received`;
    await waitFor(async () => {
      const res = await fetch(inspectUrl).catch(() => null);
      return res && res.ok;
    }, "relay:sim inspect endpoint");

    console.log("[e2e-relay-sim] relay:sim sink ready. Starting RSVP harness cloud server...");

    const harnessServerScript = path.join(root, "e2e/harness-server.ts");
    const harnessProcess = spawn(process.execPath, [tsxCli, harnessServerScript], {
      cwd: rsvpDir,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    cleanupTasks.push(async () => {
      if (harnessProcess.exitCode === null && harnessProcess.signalCode === null) {
        harnessProcess.kill("SIGTERM");
      }
    });

    const readyInfo = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for harness-server ready")), 20_000);
      harnessProcess.on("message", (msg) => {
        if (msg && typeof msg === "object" && msg.type === "ready") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      harnessProcess.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      harnessProcess.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`harness-server exited unexpectedly with code ${code}`));
      });
    });

    const apiPort = readyInfo.port;
    const tokens = readyInfo.tokens;
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    console.log(`[e2e-relay-sim] cloud harness listening at ${apiUrl}`);

    // Point printer "p1" at the simulated sink port
    await new Promise((resolve, reject) => {
      harnessProcess.send({ type: "pointPrinter", printerId: "p1", port: sinkPort });
      harnessProcess.once("message", (msg) => {
        if (msg && typeof msg === "object" && msg.type === "pointPrinterOk") resolve(null);
        else reject(new Error(`Unexpected pointPrinter response: ${JSON.stringify(msg)}`));
      });
    });

    // Enqueue a fixture print job
    const fixtureZpl = "^XA^FO20,20^FDFavor Printer Bundled Relay E2E^FS^XZ";
    const queuedJob = await new Promise((resolve, reject) => {
      harnessProcess.send({
        type: "enqueue",
        stationId: "s1",
        actionId: "act-e2e-claim-send-report",
        zpl: fixtureZpl,
      });
      harnessProcess.once("message", (msg) => {
        if (msg && typeof msg === "object" && msg.type === "enqueueOk") resolve(msg.job);
        else reject(new Error(`Unexpected enqueue response: ${JSON.stringify(msg)}`));
      });
    });

    console.log(`[e2e-relay-sim] enqueued fixture job ${queuedJob.id}`);

    // Build start options using the app's relayConfig builder
    const buildOptions = await loadRelayConfigBuilder(root);
    const relaySupportDir = path.join(tempDir, "relay-support");
    await mkdir(relaySupportDir, { recursive: true });

    const startOptions = buildOptions({
      apiUrl,
      credentials: { relayId: "relay-a", token: tokens["relay-a"] },
      queue: "Favor_ZD421",
      appSupportDir: relaySupportDir,
      appVersion: "0.1.0",
      osVersion: "macOS 15.0",
      printerAttached: true,
    });
    // Use TCP transport directed to relay:sim sink
    startOptions.transport = { kind: "tcp" };
    startOptions.pollMs = 50;
    startOptions.heartbeatMs = 100;
    startOptions.configRefreshMs = 200;

    console.log("[e2e-relay-sim] forking bundled relay (dist/relay.js) with ELECTRON_RUN_AS_NODE=1...");
    const relayChild = fork(relayJsPath, [], {
      execPath: electronBin,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    cleanupTasks.push(async () => {
      if (relayChild.exitCode === null && relayChild.signalCode === null) {
        relayChild.kill("SIGKILL");
      }
    });

    const relayEvents = [];
    let relayStopped = false;
    relayChild.on("message", (msg) => {
      if (msg && typeof msg === "object") {
        if (msg.type === "event") relayEvents.push(msg.event);
        if (msg.type === "stopped") relayStopped = true;
      }
    });

    relayChild.send({ type: "start", options: startOptions });

    // 1. Assert label received by the relay:sim sink
    console.log("[e2e-relay-sim] waiting for label to arrive at simulated printer sink...");
    const receivedLabels = await waitFor(async () => {
      const res = await fetch(inspectUrl);
      const list = await res.json();
      return Array.isArray(list) && list.length > 0 ? list : null;
    }, "label receipt at simulated printer");

    if (receivedLabels[0].zpl !== fixtureZpl) {
      throw new Error(`Received ZPL mismatch: expected '${fixtureZpl}', got '${receivedLabels[0].zpl}'`);
    }
    console.log("[e2e-relay-sim] ok: fake Zebra sink received matching ZPL");

    // 2. Assert server job record shows status: "sent" and claimedBy: "relay-a"
    console.log("[e2e-relay-sim] waiting for server job record to reach status: 'sent'...");
    const finalJobRecord = await waitFor(async () => {
      return new Promise((resolve) => {
        harnessProcess.send({ type: "getJob", jobId: queuedJob.id });
        harnessProcess.once("message", (msg) => {
          if (msg && typeof msg === "object" && msg.type === "getJobOk" && msg.job?.status === "sent") {
            resolve(msg.job);
          } else {
            resolve(null);
          }
        });
      });
    }, "server job record sent status");

    assertJobRecordClaim(finalJobRecord, "relay-a");
    console.log("[e2e-relay-sim] ok: job claim belongs to Favor Printer relay id (relay-a), never helper relay");

    // 3. Stop relay and assert clean shutdown and empty spool
    relayChild.send({ type: "stop" });
    await waitFor(() => relayStopped, "relay child stopped message");
    await waitFor(() => relayChild.exitCode !== null, "relay child process exit");
    console.log("[e2e-relay-sim] ok: bundled relay stopped cleanly");

    await assertSpoolEmpty(path.join(relaySupportDir, "spool"), { mustExist: true });
    console.log("[e2e-relay-sim] ok: spool is empty of ZPL and payload files after report");

    // 4. Revoked (401) run yields revoked event
    console.log("[e2e-relay-sim] testing revoked relay credentials (401)...");
    const revokedSupportDir = path.join(tempDir, "revoked-relay-support");
    await mkdir(revokedSupportDir, { recursive: true });

    const revokedOptions = buildOptions({
      apiUrl,
      credentials: { relayId: "relay-revoked", token: tokens["relay-revoked"] },
      queue: "Favor_ZD421",
      appSupportDir: revokedSupportDir,
      appVersion: "0.1.0",
      osVersion: "macOS 15.0",
      printerAttached: true,
    });
    revokedOptions.transport = { kind: "tcp" };
    revokedOptions.pollMs = 50;
    revokedOptions.heartbeatMs = 100;
    revokedOptions.configRefreshMs = 150;

    const revokedChild = fork(relayJsPath, [], {
      execPath: electronBin,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    cleanupTasks.push(async () => {
      if (revokedChild.exitCode === null && revokedChild.signalCode === null) {
        revokedChild.kill("SIGKILL");
      }
    });

    const revokedEvents = [];
    let revokedStopped = false;
    revokedChild.on("message", (msg) => {
      if (msg && typeof msg === "object") {
        if (msg.type === "event") revokedEvents.push(msg.event);
        if (msg.type === "stopped") revokedStopped = true;
      }
    });

    revokedChild.send({ type: "start", options: revokedOptions });

    await waitFor(() => {
      return revokedEvents.some(
        (e) => e.cloud === "revoked" || e.lastError === "credentials_rejected",
      );
    }, "revoked event from relay child");
    console.log("[e2e-relay-sim] ok: revoked credentials yielded revoked event");

    revokedChild.send({ type: "stop" });
    await waitFor(() => revokedStopped, "revoked child stopped message");
    await waitFor(() => revokedChild.exitCode !== null, "revoked child process exit");
    console.log("[e2e-relay-sim] ok: revoked relay child stopped cleanly");

    return {
      ok: true,
      skipped: false,
      jobId: queuedJob.id,
      claimedBy: finalJobRecord.claimedBy,
      labelsReceived: receivedLabels.length,
    };
  } finally {
    await runCleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runE2eRelaySim().then(
    (result) => {
      if (result.skipped) {
        console.log(`[e2e-relay-sim] skipped: ${result.reason}`);
        process.exit(0);
      }
      console.log("[e2e-relay-sim] All tests passed successfully.");
      process.exit(0);
    },
    (err) => {
      console.error("[e2e-relay-sim] Test failed:", err);
      process.exit(1);
    },
  );
}
