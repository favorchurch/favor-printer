/**
 * Local spool: one JSON file per claimed job, so claims, in-flight sends and
 * undelivered results survive a relay restart.
 *
 * A job moves through three stages on disk:
 *   claimed  claimed from the cloud, nothing written to the printer
 *   sending  the printer connection is open and bytes may have been written
 *   report   the outcome is known and still has to reach the cloud
 *
 * Files are written to a temp name and renamed into place, so a crash leaves
 * either the old or the new entry, never a torn one.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { chmod, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { ClaimedJob, ReportOutcome } from "./protocol";

export type SpoolStage = "claimed" | "sending" | "report";

/** What a job carries only while it is still unsent. */
type Payload = "zpl" | "label";

/** Everything a later stage needs: ids and the claim token, never the label. */
type SlimJob = Omit<ClaimedJob, Payload> & { claimedAt: string };

/** Claimed, nothing written to the printer. The only stage that holds the ZPL and label. */
export type ClaimedEntry = ClaimedJob & { stage: "claimed"; claimedAt: string };
/** Bytes may have gone out. The payload is gone; the job is never resent. */
export type SendingEntry = SlimJob & { stage: "sending" };
/** Outcome known, waiting to reach the cloud. */
export type ReportEntry = SlimJob & {
  stage: "report";
  outcome: ReportOutcome;
  error?: string;
};

export type SpoolEntry = ClaimedEntry | SendingEntry | ReportEntry;

/**
 * Copy of `entry` without the printable payload. A job that has left `claimed`
 * is never printed from the spool again, so keeping a child's name tag on disk
 * after that would only widen what a lost laptop exposes.
 */
export function stripPayload<T extends object>(entry: T): Omit<T, Payload> {
  const copy = { ...(entry as Record<string, unknown>) };
  delete copy.zpl;
  delete copy.label;
  return copy as Omit<T, Payload>;
}

export class SpoolLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpoolLockedError";
  }
}

type Holder = {
  pid: number;
  host: string;
  /** Per-process random nonce. Empty on records that predate it. */
  boot: string;
  /** Unique per published record. Lets an instance recognise its own record. */
  id?: string;
  /** Stable machine id. Absent on records written before it existed ("legacy"). */
  machineId?: string;
  /** OS boot session id. Absent when the writer could not read one. */
  bootSession?: string;
  /** PID namespace of the writer. Absent when the writer could not read one. */
  pidNamespace?: string;
};

/**
 * What this process knows about the machine it runs on. `hostname` is not
 * stable (a laptop renames itself when it changes network), so liveness is
 * judged on `machineId` and `bootSession`, never on the hostname alone.
 */
export type HostIdentity = {
  machineId: string;
  /** Undefined when the OS offers no boot session id, so no reboot is ever inferred. */
  bootSession: string | undefined;
  /**
   * PID namespace this process runs in (Linux). A pid only means something
   * inside its own namespace, so a record from another one cannot be judged.
   * Undefined where the OS has none.
   */
  pidNamespace?: string | undefined;
  bootTimeMs: number;
  hostname: string;
};

const run = (file: string, args: string[]): string | null => {
  try {
    const out = execFileSync(file, args, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

const readText = (file: string): string | null => {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
};

/** macOS: IOPlatformUUID. Linux: /etc/machine-id. Otherwise the hostname. */
export function readMachineId(): string {
  let id: string | null = null;
  if (process.platform === "darwin") {
    const out = run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    id = out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1].trim() || null;
  } else if (process.platform === "linux") {
    id = readText("/etc/machine-id");
  }
  return id ?? os.hostname();
}

/** macOS: kern.bootsessionuuid. Linux: boot_id. Undefined when neither can be read. */
export function readBootSessionId(): string | undefined {
  if (process.platform === "darwin") return run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]) ?? undefined;
  if (process.platform === "linux") return readText("/proc/sys/kernel/random/boot_id") ?? undefined;
  return undefined;
}

/** Linux: the PID namespace link target, e.g. "pid:[4026531836]". Undefined elsewhere. */
export function readPidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid") || undefined;
  } catch {
    return undefined;
  }
}

/** When the OS last booted, in ms since epoch. */
export function readOsBootTimeMs(): number {
  let seconds: string | undefined;
  if (process.platform === "darwin") {
    seconds = run("/usr/sbin/sysctl", ["-n", "kern.boottime"])?.match(/sec\s*=\s*(\d+)/)?.[1];
  } else if (process.platform === "linux") {
    seconds = readText("/proc/stat")?.match(/^btime\s+(\d+)/m)?.[1];
  }
  return seconds ? Number(seconds) * 1000 : Date.now() - os.uptime() * 1000;
}

let identityMemo: Omit<HostIdentity, "hostname"> | undefined;

/** Read once per process, on first use, so importing this module spawns nothing. */
const hostIdentity = (override: Partial<HostIdentity> = {}): HostIdentity => {
  identityMemo ??= {
    machineId: readMachineId(),
    bootSession: readBootSessionId(),
    pidNamespace: readPidNamespace(),
    bootTimeMs: readOsBootTimeMs(),
  };
  return { ...identityMemo, hostname: os.hostname(), ...override };
};

/**
 * Random id for this process instance. It marks which lock records are ours
 * to release, and tells a legacy record apart from a predecessor that reused
 * this process's pid after a container restart.
 */
const BOOT_ID = randomUUID();

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const parseHolder = (raw: string): Holder | null => {
  try {
    const value = JSON.parse(raw) as Partial<Holder> | null;
    if (
      value &&
      typeof value === "object" &&
      Number.isInteger(value.pid) &&
      typeof value.host === "string" &&
      value.host.length > 0
    ) {
      return {
        pid: value.pid as number,
        host: value.host,
        boot: typeof value.boot === "string" ? value.boot : "",
        id: nonEmpty(value.id),
        machineId: nonEmpty(value.machineId),
        bootSession: nonEmpty(value.bootSession),
        pidNamespace: nonEmpty(value.pidNamespace),
      };
    }
  } catch {
    // fall through
  }
  return null;
};

/**
 * Whether the process that wrote a holder record is provably gone.
 *
 * - Unparsable or empty data is dead. Holder files are only ever published
 *   complete (see `createExclusive`), so a torn record means its writer
 *   crashed. For a send marker this makes the job ambiguous, never resent.
 * - A record carrying our nonce was written by this process, so live.
 * - A record with a machine id:
 *   - another machine's is live: we cannot check its processes.
 *   - the same machine under another boot session is dead: no process
 *     survives a reboot, whatever its pid or hostname says now.
 *   - the same machine and boot session under another PID namespace is live:
 *     its pid is not ours to look up, and our own pid there is a different
 *     process, so neither the pid check nor the nonce rule applies.
 *   - the same machine, boot session and PID namespace, carrying our pid under
 *     another nonce, is a predecessor whose pid was reused after a restart,
 *     so dead.
 *   - otherwise that same machine, boot session and namespace is dead only
 *     when its pid is gone.
 * - A legacy record (no machine id):
 *   - one on this host carrying our pid under another nonce is a predecessor
 *     whose pid was reused after a restart, so dead.
 *   - any other live pid is live.
 *   - a dead pid is dead when the file predates the current OS boot, whatever
 *     the hostname says, or when it names this host. Otherwise it may belong
 *     to another machine, so it is live.
 *
 * `mtimeMs` is the holder file's modification time. The file is published
 * complete when the holder starts, so it dates the holder.
 */
const holderIsDead = (holder: Holder | null, mtimeMs: number | undefined, identity: HostIdentity) => {
  if (holder === null) return true;
  if (holder.boot === BOOT_ID) return false;
  if (holder.machineId !== undefined) {
    if (holder.machineId !== identity.machineId) return false;
    if (
      holder.bootSession !== undefined &&
      identity.bootSession !== undefined &&
      holder.bootSession !== identity.bootSession
    ) {
      return true;
    }
    // A pid only names a process inside its own PID namespace. Another
    // namespace's record (a sibling container sharing the spool volume) may
    // carry our pid or a live one of ours: neither the pid check nor the nonce
    // rule can judge it, so it is never taken over.
    if (holder.pidNamespace !== undefined && holder.pidNamespace !== identity.pidNamespace) return false;
    if (holder.pid === process.pid) return true;
    return !pidAlive(holder.pid);
  }
  if (holder.pid === process.pid && holder.host === identity.hostname) return true;
  if (pidAlive(holder.pid)) return false;
  return holder.host === identity.hostname || (mtimeMs !== undefined && mtimeMs < identity.bootTimeMs);
};

/** "held": a live process owns the send. "stale": its owner died mid-send. */
export type SendMarkerState = "none" | "held" | "stale";

export type FileSpoolHooks = {
  /** Test seam: runs after a lock is judged stale, before it is taken over. */
  beforeTakeover?: () => Promise<void>;
  /** Test seam: runs after a takeover right is judged dead, before it is recovered. */
  beforeRecoverRight?: () => Promise<void>;
  /** Test seam: runs once a stale file is confirmed under the right, before removal. */
  beforeRemoveStale?: (file: string) => Promise<void>;
  /** Test seam: replaces what this process reports about its machine and boot. */
  identity?: Partial<HostIdentity>;
};

export class FileSpool {
  /** Record id of the lock this instance published, so it can tell it is still the holder. */
  private lockId: string | undefined;

  constructor(
    private readonly dir: string,
    private readonly hooks: FileSpoolHooks = {},
  ) {}

  private file(jobId: string) {
    return path.join(this.dir, `${jobId}.json`);
  }

  private identity() {
    return hostIdentity(this.hooks.identity);
  }

  /** This process's holder record. `id` makes every published record unique, so
   * the takeover right derived from one dead record never collides with another's. */
  private ownHolder() {
    const { machineId, bootSession, pidNamespace, hostname } = this.identity();
    return { pid: process.pid, host: hostname, boot: BOOT_ID, id: randomUUID(), machineId, bootSession, pidNamespace };
  }

  private holderIsDead(holder: Holder | null, mtimeMs: number | undefined) {
    return holderIsDead(holder, mtimeMs, this.identity());
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory alone, so tighten it explicitly.
    await chmod(this.dir, 0o700);
  }

  /**
   * Atomically write or replace an entry. Only a `claimed` entry keeps its ZPL
   * and label: any other stage is stripped here, whatever the caller passed.
   */
  async write(entry: SpoolEntry) {
    await this.init();
    const target = this.file(entry.id);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const stored = entry.stage === "claimed" ? entry : stripPayload(entry);
    await writeFile(temp, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  }

  /** Add a freshly claimed job unless one with that id is already held. */
  async addClaimed(job: ClaimedJob, now: Date): Promise<boolean> {
    if (await this.get(job.id)) return false;
    await this.write({ ...job, stage: "claimed", claimedAt: now.toISOString() });
    return true;
  }

  async get(jobId: string): Promise<SpoolEntry | null> {
    try {
      return JSON.parse(await readFile(this.file(jobId), "utf8")) as SpoolEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(jobId: string) {
    await rm(this.file(jobId), { force: true });
    await this.releaseSend(jobId);
  }

  /**
   * Create `file` holding this process's holder record, failing if it exists.
   * The record is written to a temp file first and published with link(2),
   * which is atomic and refuses an existing target, so the file is never
   * visible empty or half-written.
   */
  private async createExclusive(file: string, holder = this.ownHolder()): Promise<boolean> {
    await this.init();
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(holder), { encoding: "utf8", mode: 0o600 });
    try {
      await link(temp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Raw holder text and file mtime, or null when the file does not exist. */
  private async readHolderRaw(file: string): Promise<{ raw: string; mtimeMs: number } | null> {
    try {
      const [raw, { mtimeMs }] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      return { raw, mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private lockFile() {
    return path.join(this.dir, ".relay.lock");
  }

  /**
   * Make this process the only relay on the spool. Created atomically, so two
   * starters cannot both win. A lock left by a dead process on this machine is
   * recovered, whatever the hostname is now; a live or foreign holder is refused.
   */
  async acquireLock() {
    const lock = this.lockFile();
    // Every recovery pass removes one dead file, so only passes that change
    // nothing count against the limit. A chain of any depth is recovered.
    for (let stalls = 0; stalls < FileSpool.MAX_STALLED_PASSES; ) {
      const mine = this.ownHolder();
      if (await this.createExclusive(lock, mine)) {
        this.lockId = mine.id;
        await this.sweepOrphanedWrites();
        return;
      }
      const current = await this.readHolderRaw(lock);
      if (current === null) {
        stalls++; // released between our attempts
        continue;
      }
      const { raw } = current;
      const holder = parseHolder(raw);
      // This instance's own record: already the holder, nothing to recover.
      if (holder?.id !== undefined && holder.id === this.lockId) return;
      if (!this.holderIsDead(holder, current.mtimeMs)) {
        throw new SpoolLockedError(
          `spool ${this.dir} is locked by ${
            holder ? `pid ${holder.pid} on ${holder.host}` : "another relay"
          }`,
        );
      }
      await this.hooks.beforeTakeover?.();
      if (!(await this.takeOverStaleLock(lock, raw))) stalls++;
    }
    throw new SpoolLockedError(`spool ${this.dir} lock could not be recovered`);
  }

  private static readonly MAX_STALLED_PASSES = 5;

  /**
   * Temp files of entry writes that a crashed owner never renamed into place.
   * They can hold a full claimed entry, ZPL included, that nothing will ever
   * read. Only the lock owner calls this, so no live writer loses its file.
   */
  private async sweepOrphanedWrites() {
    for (const name of await readdir(this.dir)) {
      if (/\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) {
        await rm(path.join(this.dir, name), { force: true });
      }
    }
  }

  /** The right to remove the file holding `record`. Flat, so names never grow. */
  private rightFor(record: string) {
    const digest = createHash("sha256").update(record).digest("hex");
    return `${this.lockFile()}.${digest}.takeover`;
  }

  /**
   * One recovery pass over the dead lock. Returns whether a dead file was
   * removed.
   *
   * The right to remove one particular dead record is a `.takeover` file named
   * from that record, created exclusively and carrying the taker's own holder
   * record. Only one starter can create it. The winner then checks the file
   * still holds the record it judged dead: if a new holder replaced it after
   * that judgement, the winner stands down without touching it. While the
   * right exists nobody else can remove the dead record, so removing it by
   * path is safe.
   *
   * A taker that crashed while holding a right left a `.takeover` with a dead
   * holder, which can itself have a crashed taker, and so on. The pass walks
   * that chain to its deepest file whose right is free and removes that file
   * under its right. Each pass shrinks the chain by one dead level, a crash
   * during a pass leaves at most one more level, and nothing ever has to be
   * deleted by hand. A live taker anywhere in the chain is refused.
   */
  private async takeOverStaleLock(lock: string, judgedDead: string): Promise<boolean> {
    let file = lock;
    let record = judgedDead;
    const visited = new Set<string>();
    for (;;) {
      const right = this.rightFor(record);
      if (visited.has(right)) {
        throw new SpoolLockedError(`spool ${this.dir} takeover chain loops at ${right}`);
      }
      visited.add(right);
      if (await this.createExclusive(right)) {
        try {
          if ((await this.readHolderRaw(file))?.raw !== record) return false;
          await this.hooks.beforeRemoveStale?.(file);
          await rm(file, { force: true });
          return true;
        } finally {
          await rm(right, { force: true });
        }
      }
      const rightHolder = await this.readHolderRaw(right);
      if (rightHolder === null) return false; // released between our steps
      const rightRaw = rightHolder.raw;
      const taker = parseHolder(rightRaw);
      if (!this.holderIsDead(taker, rightHolder.mtimeMs)) {
        throw new SpoolLockedError(
          `spool ${this.dir} lock is being recovered by ${
            taker ? `pid ${taker.pid} on ${taker.host}` : "another relay"
          }`,
        );
      }
      // The taker died holding the right. Descend and recover the right first.
      await this.hooks.beforeRecoverRight?.();
      file = right;
      record = rightRaw;
    }
  }

  async releaseLock() {
    const current = await this.readHolderRaw(this.lockFile());
    // Matched on the record id this instance published, not the hostname (it
    // can change while the relay runs) and not the process nonce (another
    // spool instance in this process shares it).
    const id = current === null ? undefined : parseHolder(current.raw)?.id;
    if (id !== undefined && id === this.lockId) {
      await rm(this.lockFile(), { force: true });
      this.lockId = undefined;
    }
  }

  private sendFile(jobId: string) {
    return path.join(this.dir, `${jobId}.send`);
  }

  /**
   * Take the exclusive right to write this job to a printer. Created
   * atomically before the TCP write; exactly one caller ever gets `true`.
   */
  async claimSend(jobId: string): Promise<boolean> {
    return this.createExclusive(this.sendFile(jobId));
  }

  /** Give the right back, only when nothing was written. */
  async releaseSend(jobId: string) {
    await rm(this.sendFile(jobId), { force: true });
  }

  async sendMarker(jobId: string): Promise<SendMarkerState> {
    const marker = await this.readHolderRaw(this.sendFile(jobId));
    if (marker === null) return "none";
    return this.holderIsDead(parseHolder(marker.raw), marker.mtimeMs) ? "stale" : "held";
  }

  /**
   * All entries, oldest claim first. Unreadable files are set aside, not deleted.
   * Entries from an older relay that still carry a payload past `claimed` are
   * rewritten without it. A failed rewrite throws, so `list()` fails closed
   * until the entry has been durably rewritten.
   */
  async list(): Promise<SpoolEntry[]> {
    await this.init();
    const entries: SpoolEntry[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      let entry: SpoolEntry;
      try {
        entry = JSON.parse(await readFile(file, "utf8")) as SpoolEntry;
      } catch {
        await rename(file, `${file}.corrupt`).catch(() => undefined);
        continue;
      }
      if (entry.stage !== "claimed" && ("zpl" in entry || "label" in entry)) {
        // Written by a relay from before payloads were dropped. Never print it
        // from here, so shed the payload now rather than wait for its report.
        // If the rewrite fails the error propagates: the old file still holds
        // the payload, so the spool stays closed until a rewrite succeeds.
        entry = stripPayload(entry) as SpoolEntry;
        await this.write(entry);
      }
      entries.push(entry);
    }
    return entries.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt));
  }
}
