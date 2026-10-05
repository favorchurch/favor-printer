import { describe, expect, it } from "vitest";

import { createPrefsStore, DEFAULT_PREFS, parsePrefs, type PrefsFileSystem } from "./prefs";

function memoryFs(initial: string | null = null) {
  let content = initial;
  const writes: string[] = [];
  const fs: PrefsFileSystem = {
    read: async () => content,
    write: async (_file, data) => {
      content = data;
      writes.push(data);
    },
  };
  return { fs, writes, content: () => content };
}

describe("parsePrefs", () => {
  it("falls back to defaults for anything that is not an object", () => {
    for (const raw of [null, undefined, 42, "x", []]) expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
  });

  it("keeps valid values", () => {
    const prefs = {
      openAtLogin: false,
      channel: "preview",
      selectedPrinterId: "usb://z/1",
      queue: "Favor_S1",
      label: "Front desk",
      revoked: true,
      setupComplete: true,
    };
    expect(parsePrefs(prefs)).toEqual(prefs);
  });

  it("drops each invalid field on its own", () => {
    expect(
      parsePrefs({ openAtLogin: "yes", channel: "nightly", selectedPrinterId: 5, queue: "", label: "x".repeat(500), revoked: "true", setupComplete: 1 }),
    ).toEqual(DEFAULT_PREFS);
  });

  it("ignores fields it does not know, so a token can never be carried through", () => {
    const parsed = parsePrefs({ token: "secret", relayId: "r", channel: "stable" });
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_PREFS).sort());
  });
});

describe("createPrefsStore", () => {
  it("starts from defaults when there is no file", async () => {
    const { fs } = memoryFs();
    const store = createPrefsStore({ file: "/p.json", fs });
    await expect(store.load()).resolves.toEqual(DEFAULT_PREFS);
  });

  it("starts from defaults when the file is damaged", async () => {
    const { fs } = memoryFs("{not json");
    await expect(createPrefsStore({ file: "/p.json", fs }).load()).resolves.toEqual(DEFAULT_PREFS);
  });

  it("starts from defaults when the file cannot be read", async () => {
    const store = createPrefsStore({
      file: "/p.json",
      fs: {
        read: async () => {
          throw new Error("EACCES");
        },
        write: async () => undefined,
      },
    });
    await expect(store.load()).resolves.toEqual(DEFAULT_PREFS);
  });

  it("saves updates and reads them back", async () => {
    const { fs, content } = memoryFs();
    const store = createPrefsStore({ file: "/p.json", fs });
    await store.load();
    await store.update({ openAtLogin: false, channel: "preview" });

    expect(store.get()).toMatchObject({ openAtLogin: false, channel: "preview" });
    const reloaded = createPrefsStore({ file: "/p.json", fs: { read: async () => content(), write: async () => undefined } });
    await expect(reloaded.load()).resolves.toMatchObject({ openAtLogin: false, channel: "preview" });
  });

  it("validates what it is given", async () => {
    const { fs } = memoryFs();
    const store = createPrefsStore({ file: "/p.json", fs });
    await store.load();
    await store.update({ channel: "nightly" as never });
    expect(store.get().channel).toBe("stable");
  });

  it("writes in the order updates were made", async () => {
    const { fs, writes } = memoryFs();
    const store = createPrefsStore({ file: "/p.json", fs });
    await store.load();
    await Promise.all([store.update({ label: "one" }), store.update({ label: "two" }), store.update({ label: "three" })]);
    expect(writes.map((text) => (JSON.parse(text) as { label: string }).label)).toEqual(["one", "two", "three"]);
  });

  it("never writes a credential field", async () => {
    const { fs, content } = memoryFs();
    const store = createPrefsStore({ file: "/p.json", fs });
    await store.load();
    await store.update({ label: "Front desk" });
    expect(content()).not.toMatch(/token|secret|password/i);
  });
});
