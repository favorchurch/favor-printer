/**
 * The few things the app remembers between launches, in one JSON file in the
 * app's support folder. No credentials: the token lives only in the secret
 * store. Every field is validated on load, so a hand-edited or damaged file
 * falls back to defaults instead of breaking startup.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { isUpdateChannel, type UpdateChannel } from "../../shared";

export type Prefs = {
  /** Null until the first run has chosen the default. */
  openAtLogin: boolean | null;
  channel: UpdateChannel;
  selectedPrinterId: string | null;
  /** Last CUPS queue bound to the printer, so the relay can start with the printer unplugged. */
  queue: string | null;
  /** Admin-chosen name of this laptop. */
  label: string | null;
  /** The cloud rejected the saved token. Stays until the volunteer enrolls again. */
  revoked: boolean;
  setupComplete: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  openAtLogin: null,
  channel: "stable",
  selectedPrinterId: null,
  queue: null,
  label: null,
  revoked: false,
  setupComplete: false,
};

export type PrefsFileSystem = {
  /** Resolves null when the file does not exist. */
  read(file: string): Promise<string | null>;
  write(file: string, data: string): Promise<void>;
};

export const nodePrefsFileSystem: PrefsFileSystem = {
  async read(file) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async write(file, data) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  },
};

const text = (value: unknown, max = 2048): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

export function parsePrefs(raw: unknown): Prefs {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    openAtLogin: typeof source.openAtLogin === "boolean" ? source.openAtLogin : null,
    channel: isUpdateChannel(source.channel) ? source.channel : DEFAULT_PREFS.channel,
    selectedPrinterId: text(source.selectedPrinterId),
    queue: text(source.queue, 127),
    label: text(source.label, 200),
    revoked: source.revoked === true,
    setupComplete: source.setupComplete === true,
  };
}

export type PrefsStore = {
  load(): Promise<Prefs>;
  /** The values as of the last `load` or `update`. */
  get(): Prefs;
  update(patch: Partial<Prefs>): Promise<Prefs>;
};

export function createPrefsStore(deps: { file: string; fs?: PrefsFileSystem }): PrefsStore {
  const fs = deps.fs ?? nodePrefsFileSystem;
  let current: Prefs = { ...DEFAULT_PREFS };
  // Writes run one at a time, so two quick updates cannot reorder on disk.
  let writing: Promise<unknown> = Promise.resolve();

  return {
    async load() {
      try {
        const raw = await fs.read(deps.file);
        current = raw === null ? { ...DEFAULT_PREFS } : parsePrefs(JSON.parse(raw));
      } catch {
        current = { ...DEFAULT_PREFS };
      }
      return current;
    },
    get: () => current,
    update(patch) {
      current = parsePrefs({ ...current, ...patch });
      const snapshot = JSON.stringify(current, null, 2);
      const write = writing.then(() => fs.write(deps.file, snapshot));
      writing = write.catch(() => undefined);
      return write.then(() => current);
    },
  };
}
