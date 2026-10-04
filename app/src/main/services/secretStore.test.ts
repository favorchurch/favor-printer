import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createSecretStore,
  nodeSecretFileSystem,
  SecretStoreUnavailableError,
  type SafeStorageAdapter,
  type SecretFileSystem,
} from "./secretStore";

const CREDENTIALS = { relayId: "relay-1", token: "tok-super-secret-123" };
const FILE = "/data/Favor Printer/relay-credentials.bin";

/** Not real encryption: enough that the plaintext is not in the bytes. */
function fakeSafeStorage(overrides: Partial<SafeStorageAdapter> = {}): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, "utf8").reverse().toString("base64")}`),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not encrypted");
      return Buffer.from(text.slice(4), "base64").reverse().toString("utf8");
    },
    ...overrides,
  };
}

function memoryFs() {
  const files = new Map<string, Buffer>();
  const log: string[] = [];
  const modes = new Map<string, number>();
  const fs: SecretFileSystem = {
    async mkdir(dir, mode) {
      log.push(`mkdir ${dir} ${mode.toString(8)}`);
    },
    async writeFile(file, data, mode) {
      log.push(`write ${file}`);
      files.set(file, data);
      modes.set(file, mode);
    },
    async rename(from, to) {
      log.push(`rename ${from} ${to}`);
      files.set(to, files.get(from)!);
      modes.set(to, modes.get(from)!);
      files.delete(from);
    },
    async readFile(file) {
      return files.get(file) ?? null;
    },
    async remove(file) {
      log.push(`remove ${file}`);
      files.delete(file);
    },
  };
  return { fs, files, log, modes };
}

describe("secret store", () => {
  it("saves encrypted, with mode 0600, through a temporary file", async () => {
    const memory = memoryFs();
    await createSecretStore({ file: FILE, safeStorage: fakeSafeStorage(), fs: memory.fs }).save(CREDENTIALS);

    expect(memory.log).toEqual([
      `mkdir ${path.dirname(FILE)} 700`,
      `write ${FILE}.tmp`,
      `rename ${FILE}.tmp ${FILE}`,
    ]);
    expect(memory.modes.get(FILE)).toBe(0o600);
    const stored = memory.files.get(FILE)!.toString("utf8");
    expect(stored).not.toContain(CREDENTIALS.token);
    expect(stored).not.toContain(CREDENTIALS.relayId);
    expect(memory.files.has(`${FILE}.tmp`)).toBe(false);
  });

  it("loads what it saved, so enrollment survives a relaunch", async () => {
    const memory = memoryFs();
    await createSecretStore({ file: FILE, safeStorage: fakeSafeStorage(), fs: memory.fs }).save(CREDENTIALS);
    const reopened = createSecretStore({ file: FILE, safeStorage: fakeSafeStorage(), fs: memory.fs });
    expect(await reopened.load()).toEqual(CREDENTIALS);
  });

  it("refuses to write plaintext when encryption is unavailable", async () => {
    const memory = memoryFs();
    const store = createSecretStore({
      file: FILE,
      safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
      fs: memory.fs,
    });
    const error = await store.save(CREDENTIALS).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SecretStoreUnavailableError);
    expect((error as Error).message).not.toContain(CREDENTIALS.token);
    expect(memory.log).toEqual([]);
    expect(memory.files.size).toBe(0);
  });

  it("refuses the Linux basic_text backend, which is plaintext in practice", async () => {
    const memory = memoryFs();
    const store = createSecretStore({
      file: FILE,
      safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }),
      fs: memory.fs,
    });
    await expect(store.save(CREDENTIALS)).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(memory.files.size).toBe(0);
  });

  it("never encrypts when it cannot store", async () => {
    let encrypted = 0;
    const store = createSecretStore({
      file: FILE,
      safeStorage: fakeSafeStorage({
        isEncryptionAvailable: () => false,
        encryptString: () => {
          encrypted += 1;
          return Buffer.alloc(0);
        },
      }),
      fs: memoryFs().fs,
    });
    await store.save(CREDENTIALS).catch(() => undefined);
    expect(encrypted).toBe(0);
  });

  it("loads null when nothing is saved", async () => {
    const store = createSecretStore({ file: FILE, safeStorage: fakeSafeStorage(), fs: memoryFs().fs });
    expect(await store.load()).toBeNull();
  });

  it("loads null when encryption is unavailable", async () => {
    const memory = memoryFs();
    await createSecretStore({ file: FILE, safeStorage: fakeSafeStorage(), fs: memory.fs }).save(CREDENTIALS);
    const store = createSecretStore({
      file: FILE,
      safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
      fs: memory.fs,
    });
    expect(await store.load()).toBeNull();
  });

  it("loads null for a file it cannot decrypt, or that holds the wrong shape", async () => {
    const memory = memoryFs();
    memory.files.set(FILE, Buffer.from("garbage"));
    const store = createSecretStore({ file: FILE, safeStorage: fakeSafeStorage(), fs: memory.fs });
    expect(await store.load()).toBeNull();

    for (const wrong of [{ relayId: "r" }, { token: "t" }, { relayId: "", token: "t" }, "text", null, [1]]) {
      memory.files.set(FILE, fakeSafeStorage().encryptString(JSON.stringify(wrong)));
      expect(await store.load()).toBeNull();
    }
  });

  it("clears the saved credentials", async () => {
    const memory = memoryFs();
    const store = createSecretStore({ file: FILE, safeStorage: fakeSafeStorage(), fs: memory.fs });
    await store.save(CREDENTIALS);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe("nodeSecretFileSystem", () => {
  it("writes a 0600 file, reads it back, and reports a missing file as null", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "favor-printer-secret-"));
    try {
      const file = path.join(dir, "nested", "creds.bin");
      expect(await nodeSecretFileSystem.readFile(file)).toBeNull();

      await nodeSecretFileSystem.mkdir(path.dirname(file), 0o700);
      await nodeSecretFileSystem.writeFile(file, Buffer.from("bytes"), 0o600);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await nodeSecretFileSystem.readFile(file))?.toString("utf8")).toBe("bytes");

      // A leftover file with looser permissions is tightened, not trusted.
      await nodeSecretFileSystem.writeFile(file, Buffer.from("again"), 0o600);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await readFile(file)).toString("utf8")).toBe("again");

      await nodeSecretFileSystem.remove(file);
      expect(await nodeSecretFileSystem.readFile(file)).toBeNull();
      await nodeSecretFileSystem.remove(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
