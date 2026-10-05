/**
 * The relay token, encrypted with Electron's safeStorage and written to one
 * file with mode 0600. The store refuses to write when encryption is not
 * available: a plaintext token on disk is worse than asking to enroll again.
 * Nothing here logs, and errors never carry the token.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoredCredentials = { relayId: string; token: string };

/** The slice of Electron's `safeStorage` the store uses. */
export type SafeStorageAdapter = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only. `basic_text` means the "encryption" is a fixed key, which is plaintext in practice. */
  getSelectedStorageBackend?(): string;
};

export type SecretFileSystem = {
  mkdir(dir: string, mode: number): Promise<void>;
  /** Writes the whole file with the given mode. */
  writeFile(file: string, data: Buffer, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Resolves null when the file does not exist. */
  readFile(file: string): Promise<Buffer | null>;
  remove(file: string): Promise<void>;
};

export class SecretStoreUnavailableError extends Error {
  constructor() {
    super("Secure storage is not available, so the token was not saved");
    this.name = "SecretStoreUnavailableError";
  }
}

export const nodeSecretFileSystem: SecretFileSystem = {
  async mkdir(dir, mode) {
    await mkdir(dir, { recursive: true, mode });
  },
  async writeFile(file, data, mode) {
    await writeFile(file, data, { mode });
    // `mode` only applies when the file is created; a leftover file keeps its old one.
    await chmod(file, mode);
  },
  rename,
  async readFile(file) {
    try {
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async remove(file) {
    await rm(file, { force: true });
  },
};

export type SecretStore = {
  save(credentials: StoredCredentials): Promise<void>;
  /** Null when nothing is saved, the file is unreadable, or it cannot be decrypted. The caller treats all three as "not enrolled". */
  load(): Promise<StoredCredentials | null>;
  clear(): Promise<void>;
};

export function createSecretStore(deps: {
  file: string;
  safeStorage: SafeStorageAdapter;
  fs?: SecretFileSystem;
}): SecretStore {
  const { file, safeStorage } = deps;
  const fs = deps.fs ?? nodeSecretFileSystem;

  const encryptionUsable = () =>
    safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";

  return {
    async save(credentials) {
      if (!encryptionUsable()) throw new SecretStoreUnavailableError();
      const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
      await fs.mkdir(path.dirname(file), 0o700);
      // Write beside the target and rename, so a crash never leaves half a token.
      const temporary = `${file}.tmp`;
      await fs.writeFile(temporary, encrypted, 0o600);
      await fs.rename(temporary, file);
    },

    async load() {
      if (!encryptionUsable()) return null;
      try {
        const encrypted = await fs.readFile(file);
        if (!encrypted) return null;
        const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted));
        if (typeof parsed !== "object" || parsed === null) return null;
        const { relayId, token } = parsed as Record<string, unknown>;
        if (typeof relayId !== "string" || !relayId || typeof token !== "string" || !token) return null;
        return { relayId, token };
      } catch {
        return null;
      }
    },

    async clear() {
      await fs.remove(file);
    },
  };
}
