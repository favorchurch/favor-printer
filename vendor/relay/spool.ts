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

import { chmod, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

type Holder = { pid: number; host: string; boot: string };

/**
 * Random id for this process instance. A restarted container can reuse both
 * its hostname and its pid (often 1), so pid + host alone cannot tell this
 * process from the one that wrote a holder record before the restart.
 */
const BOOT_ID = randomUUID();

/**
 * This process's holder record. `id` makes every published record unique, so
 * the takeover right derived from one dead record never collides with
 * another's.
 */
const ownHolder = () => ({ pid: process.pid, host: os.hostname(), boot: BOOT_ID, id: randomUUID() });

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

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
 * - Another host's holder is live: we cannot check its processes.
 * - A record carrying our boot id is ours, so live.
 * - A record with our pid but another boot id is a predecessor whose pid was
 *   reused after a restart, so dead.
 * - Otherwise the pid decides.
 */
const holderIsDead = (holder: Holder | null) => {
  if (holder === null) return true;
  if (holder.host !== os.hostname()) return false;
  if (holder.boot === BOOT_ID) return false;
  if (holder.pid === process.pid) return true;
  return !pidAlive(holder.pid);
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
};

export class FileSpool {
  constructor(
    private readonly dir: string,
    private readonly hooks: FileSpoolHooks = {},
  ) {}

  private file(jobId: string) {
    return path.join(this.dir, `${jobId}.json`);
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
  private async createExclusive(file: string): Promise<boolean> {
    await this.init();
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(ownHolder()), { encoding: "utf8", mode: 0o600 });
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

  /** Raw holder text, or null when the file does not exist. */
  private async readHolderRaw(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readHolder(file: string): Promise<Holder | null> {
    const raw = await this.readHolderRaw(file);
    return raw === null ? null : parseHolder(raw);
  }

  private lockFile() {
    return path.join(this.dir, ".relay.lock");
  }

  /**
   * Make this process the only relay on the spool. Created atomically, so two
   * starters cannot both win. A lock left by a dead process on this host is
   * recovered; a live or foreign holder is refused.
   */
  async acquireLock() {
    const lock = this.lockFile();
    // Every recovery pass removes one dead file, so only passes that change
    // nothing count against the limit. A chain of any depth is recovered.
    for (let stalls = 0; stalls < FileSpool.MAX_STALLED_PASSES; ) {
      if (await this.createExclusive(lock)) {
        await this.sweepOrphanedWrites();
        return;
      }
      const raw = await this.readHolderRaw(lock);
      if (raw === null) {
        stalls++; // released between our attempts
        continue;
      }
      const holder = parseHolder(raw);
      if (!holderIsDead(holder)) {
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
          if ((await this.readHolderRaw(file)) !== record) return false;
          await this.hooks.beforeRemoveStale?.(file);
          await rm(file, { force: true });
          return true;
        } finally {
          await rm(right, { force: true });
        }
      }
      const rightRaw = await this.readHolderRaw(right);
      if (rightRaw === null) return false; // released between our steps
      const taker = parseHolder(rightRaw);
      if (!holderIsDead(taker)) {
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
    const holder = await this.readHolder(this.lockFile());
    if (holder?.boot === BOOT_ID && holder.host === os.hostname()) {
      await rm(this.lockFile(), { force: true });
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
    const raw = await this.readHolderRaw(this.sendFile(jobId));
    if (raw === null) return "none";
    return holderIsDead(parseHolder(raw)) ? "stale" : "held";
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
