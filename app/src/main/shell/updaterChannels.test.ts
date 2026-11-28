/**
 * Update channels, against the real electron-updater 6.8.9 `AppUpdater` and `GitHubProvider` with a
 * mocked GitHub: the Atom release feed, `/releases/latest`, and the channel files (`latest-mac.yml`,
 * `beta-mac.yml`, ...). Nothing here touches the network. The updater is configured by our own
 * adapter, so what these tests check is what ships.
 *
 * Releases are tagged `vX.Y.Z` (stable) and `vX.Y.Z-beta.N` (Preview). In 6.8.9 the GitHub provider
 * offers a client on the `alpha` or `beta` channel only stable and `beta` releases, which is why
 * Preview is the `beta` channel.
 */

import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AppUpdater } from "electron-updater/out/AppUpdater";
import type { AppAdapter } from "electron-updater/out/AppAdapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateChannel, UpdateState } from "../../shared";
import { channelSettings, createUpdateController, type UpdaterEvent } from "../services";
import { createFakeTimers } from "../services/testing/fakes";
import { createUpdaterAdapter, type AutoUpdaterLike } from "./updaterAdapter";

const OWNER = "favorchurch";
const REPO = "favor-printer";

// `builder-util-runtime` is electron-updater's own dependency: resolve it the way electron-updater does.
const requireFromUpdater = createRequire(createRequire(import.meta.url).resolve("electron-updater"));
const { HttpError } = requireFromUpdater("builder-util-runtime") as {
  HttpError: new (statusCode: number, description?: string) => Error;
};

const prereleaseId = (tag: string): string | null => /-([A-Za-z]+)\./.exec(tag)?.[1] ?? null;
const versionOf = (tag: string) => tag.replace(/^v/, "");
/** The channel file electron-builder writes for a tag on macOS. */
const channelFileFor = (tag: string) => `${prereleaseId(tag) ?? "latest"}-mac.yml`;

function atomFeed(tags: string[]): string {
  const entries = tags
    .map(
      (tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/>
    <title>${versionOf(tag)}</title>
    <content type="html">Release notes</content>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/${OWNER}/${REPO}/releases</id>
  <title>Release notes from ${REPO}</title>
${entries}
</feed>`;
}

function channelYml(tag: string): string {
  const version = versionOf(tag);
  return `version: ${version}
files:
  - url: Favor-Printer-${version}-arm64.zip
    sha512: c2hhNTEy
    size: 1000
path: Favor-Printer-${version}-arm64.zip
sha512: c2hhNTEy
releaseDate: '2026-10-01T00:00:00.000Z'
`;
}

/**
 * GitHub, as far as the provider asks it: `releases` is newest first, like the Atom feed, and
 * `/releases/latest` is the newest tag that is not a prerelease, like GitHub's own.
 */
function mockGitHub(releases: string[], options: { latest?: string } = {}) {
  const latest = options.latest ?? releases.find((tag) => prereleaseId(tag) === null) ?? null;
  const requests: string[] = [];
  const executor = {
    async request(request: { path?: string }): Promise<string> {
      const requested = request.path ?? "";
      requests.push(requested);
      const base = `/${OWNER}/${REPO}/releases`;
      if (requested === `${base}.atom`) return atomFeed(releases);
      if (requested === `${base}/latest`) return JSON.stringify({ tag_name: latest });
      const download = new RegExp(`^${base}/download/([^/]+)/([^/]+)$`).exec(requested);
      if (download && releases.includes(download[1]) && download[2] === channelFileFor(download[1])) {
        return channelYml(download[1]);
      }
      throw new HttpError(404, `not found: ${requested}`);
    },
  };
  return { executor, requests, downloads: () => requests.filter((request) => request.includes("/download/")) };
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A real `AppUpdater` with the GitHub provider, on macOS, with the mocked GitHub as its HTTP. */
class TestUpdater extends AppUpdater {
  constructor(app: AppAdapter, executor: unknown) {
    super(null, app);
    const internals = this as unknown as { httpExecutor: unknown; _testOnlyOptions: { platform: string } };
    internals.httpExecutor = executor;
    internals._testOnlyOptions = { platform: "darwin" };
    this.setFeedURL({ provider: "github", owner: OWNER, repo: REPO });
  }
  protected doDownloadUpdate(): Promise<string[]> {
    return Promise.resolve([]);
  }
  quitAndInstall(): void {
    // Not part of a check.
  }
}

async function newUpdater(current: string, releases: string[], options: { latest?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "favor-printer-updater-"));
  cleanup.push(dir);
  const app: AppAdapter = {
    version: current,
    name: "Favor Printer",
    isPackaged: true,
    appUpdateConfigPath: path.join(dir, "app-update.yml"),
    userDataPath: dir,
    baseCachePath: dir,
    whenReady: async () => undefined,
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  };
  const github = mockGitHub(releases, options);
  const updater = new TestUpdater(app, github.executor);
  return { updater, github };
}

type Offer = { offered: string | null; events: UpdaterEvent[]; updater: TestUpdater; github: ReturnType<typeof mockGitHub> };

/** Runs one update check for a client on `channel`, configured by the adapter, and reports what it was offered. */
async function check(channel: UpdateChannel, current: string, releases: string[], options: { latest?: string; before?: UpdateChannel[] } = {}): Promise<Offer> {
  const { updater, github } = await newUpdater(current, releases, options);
  const adapter = createUpdaterAdapter(updater as unknown as AutoUpdaterLike, () => undefined);
  // Only ask: no download in these tests.
  updater.autoDownload = false;
  for (const earlier of options.before ?? []) adapter.configure(channelSettings(earlier));
  adapter.configure(channelSettings(channel));

  const events: UpdaterEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  let offered: string | null = null;
  updater.on("update-available", (info) => {
    offered = info.version;
  });
  await adapter.check();
  return { offered, events, updater, github };
}

const kinds = (offer: Offer) => offer.events.map((event) => event.kind);

describe("Preview: channel beta, current 1.2.0-beta.1", () => {
  const CURRENT = "1.2.0-beta.1";

  it("is configured as beta, with prereleases allowed and downgrades off", async () => {
    const { updater } = await check("preview", CURRENT, ["v1.2.0-beta.1"]);
    expect(updater.channel).toBe("beta");
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("is offered a newer stable release (1.3.0)", async () => {
    const offer = await check("preview", CURRENT, ["v1.3.0", "v1.3.0-beta.1", "v1.2.0", "v1.2.0-beta.1"]);
    expect(offer.offered).toBe("1.3.0");
    expect(kinds(offer)).toContain("available");
    expect(kinds(offer)).not.toContain("not-available");
  });

  it("finds that stable release through the default channel file, because a stable release has no beta one", async () => {
    const { github } = await check("preview", CURRENT, ["v1.3.0", "v1.3.0-beta.1", "v1.2.0", "v1.2.0-beta.1"]);
    expect(github.downloads()).toEqual([
      `/${OWNER}/${REPO}/releases/download/v1.3.0/beta-mac.yml`,
      `/${OWNER}/${REPO}/releases/download/v1.3.0/latest-mac.yml`,
    ]);
  });

  it("is offered a newer beta release (1.3.0-beta.1)", async () => {
    const offer = await check("preview", CURRENT, ["v1.3.0-beta.1", "v1.2.0", "v1.2.0-beta.1"]);
    expect(offer.offered).toBe("1.3.0-beta.1");
    expect(kinds(offer)).toContain("available");
    expect(offer.github.downloads()).toEqual([`/${OWNER}/${REPO}/releases/download/v1.3.0-beta.1/beta-mac.yml`]);
  });

  it("is offered the newest of a beta and a stable release when the beta is newer", async () => {
    const offer = await check("preview", CURRENT, ["v1.4.0-beta.1", "v1.3.0", "v1.3.0-beta.1", "v1.2.0-beta.1"]);
    expect(offer.offered).toBe("1.4.0-beta.1");
  });

  it("skips alpha and other prerelease names, and takes the next beta", async () => {
    const offer = await check("preview", CURRENT, ["v1.5.0-alpha.1", "v1.4.0-rc.1", "v1.3.0-beta.1", "v1.2.0-beta.1"]);
    expect(offer.offered).toBe("1.3.0-beta.1");
  });

  describe("is never offered a lower version", () => {
    it("not an older stable release, when it is on a newer beta", async () => {
      const offer = await check("preview", "1.3.0-beta.1", ["v1.2.0", "v1.2.0-beta.2", "v1.2.0-beta.1"]);
      expect(offer.offered).toBeNull();
      expect(kinds(offer)).toContain("not-available");
      expect(kinds(offer)).not.toContain("available");
    });

    it("not an older beta", async () => {
      const offer = await check("preview", "1.2.0-beta.2", ["v1.2.0-beta.1"]);
      expect(offer.offered).toBeNull();
      expect(kinds(offer)).toContain("not-available");
    });

    it("not the version it already has", async () => {
      const offer = await check("preview", CURRENT, ["v1.2.0-beta.1", "v1.1.0"]);
      expect(offer.offered).toBeNull();
      expect(kinds(offer)).toContain("not-available");
    });

    it("because downgrades are turned off after the channel is set: the setter alone would allow one", async () => {
      // Control: what electron-updater does by itself when a channel is set.
      const { updater } = await newUpdater("1.3.0-beta.1", ["v1.2.0", "v1.2.0-beta.2"]);
      updater.autoDownload = false;
      updater.allowPrerelease = true;
      updater.channel = "beta";
      expect(updater.allowDowngrade).toBe(true);
      let offered: string | null = null;
      updater.on("update-available", (info) => {
        offered = info.version;
      });
      await updater.checkForUpdates();
      expect(offered).toBe("1.2.0");

      // Through the adapter, the same feed offers nothing.
      const viaAdapter = await check("preview", "1.3.0-beta.1", ["v1.2.0", "v1.2.0-beta.2"]);
      expect(viaAdapter.updater.allowDowngrade).toBe(false);
      expect(viaAdapter.offered).toBeNull();
    });
  });
});

describe("Stable: no custom channel, current 1.2.0", () => {
  const CURRENT = "1.2.0";

  it("is configured with no channel, prereleases off and downgrades off", async () => {
    const { updater } = await check("stable", CURRENT, ["v1.2.0"]);
    expect(updater.channel).toBeNull();
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("is offered a newer stable release", async () => {
    const offer = await check("stable", CURRENT, ["v1.3.0", "v1.2.0"]);
    expect(offer.offered).toBe("1.3.0");
    expect(offer.github.downloads()).toEqual([`/${OWNER}/${REPO}/releases/download/v1.3.0/latest-mac.yml`]);
  });

  describe("is never offered a beta", () => {
    it("when a newer beta exists and nothing newer is stable", async () => {
      const offer = await check("stable", CURRENT, ["v1.3.0-beta.1", "v1.2.0", "v1.1.0"]);
      expect(offer.offered).toBeNull();
      expect(kinds(offer)).toContain("not-available");
      // It did not even fetch the beta's files.
      expect(offer.github.downloads().filter((request) => request.includes("beta"))).toEqual([]);
    });

    it("when a newer beta sits above a newer stable: it gets the stable one", async () => {
      const offer = await check("stable", CURRENT, ["v1.4.0-beta.1", "v1.3.0", "v1.2.0"]);
      expect(offer.offered).toBe("1.3.0");
      expect(offer.github.downloads().filter((request) => request.includes("v1.4.0-beta.1"))).toEqual([]);
    });

    it("whatever the beta's name", async () => {
      for (const tag of ["v1.9.0-beta.4", "v1.9.0-alpha.1", "v1.9.0-rc.2"]) {
        const offer = await check("stable", CURRENT, [tag, "v1.2.0"]);
        expect(offer.offered).toBeNull();
      }
    });
  });

  describe("is never offered a lower version", () => {
    it("not an older stable release", async () => {
      const offer = await check("stable", "1.3.0", ["v1.2.0", "v1.1.0"]);
      expect(offer.offered).toBeNull();
      expect(kinds(offer)).toContain("not-available");
    });

    it("not when the latest release is rolled back below the installed version", async () => {
      const offer = await check("stable", CURRENT, ["v1.3.0", "v1.1.0", "v1.0.0"], { latest: "v1.1.0" });
      expect(offer.offered).toBeNull();
    });

    it("not the version it already has", async () => {
      const offer = await check("stable", CURRENT, ["v1.2.0", "v1.1.0"]);
      expect(offer.offered).toBeNull();
    });
  });
});

describe("switching from Preview to Stable", () => {
  it("names the default channel, since a set channel cannot be cleared, and allows no downgrade", async () => {
    const { updater } = await check("stable", "1.3.0-beta.1", ["v1.3.0"], { before: ["preview"] });
    expect(updater.channel).toBe("latest");
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("offers the stable release that supersedes the beta it is running, never a newer beta", async () => {
    const offer = await check("stable", "1.3.0-beta.1", ["v1.4.0-beta.1", "v1.3.0", "v1.3.0-beta.1"], { before: ["preview"] });
    expect(offer.offered).toBe("1.3.0");
    expect(offer.github.downloads()).toEqual([`/${OWNER}/${REPO}/releases/download/v1.3.0/latest-mac.yml`]);
  });

  it("does not drop a user on a newer beta back to an older stable release", async () => {
    const offer = await check("stable", "1.4.0-beta.1", ["v1.3.0", "v1.3.0-beta.1"], { before: ["preview"] });
    expect(offer.offered).toBeNull();
  });

  it("can go back to Preview again and follow beta", async () => {
    const offer = await check("preview", "1.2.0-beta.1", ["v1.3.0-beta.1", "v1.2.0"], { before: ["preview", "stable"] });
    expect(offer.updater.channel).toBe("beta");
    expect(offer.updater.allowDowngrade).toBe(false);
    expect(offer.offered).toBe("1.3.0-beta.1");
  });
});
describe("0.3.0-beta.4 against a 0.3.0-beta.5 release", () => {
  const RELEASES = ["v0.3.0-beta.5", "v0.3.0-beta.4"];

  it("offers a Preview client 0.3.0-beta.5, with downgrades still off", async () => {
    const offer = await check("preview", "0.3.0-beta.4", RELEASES);
    expect(offer.offered).toBe("0.3.0-beta.5");
    expect(kinds(offer)).toEqual(["checking", "available"]);
    expect(offer.updater.allowDowngrade).toBe(false);
  });

  it("does not offer a Stable client that beta, and does not even fetch its files", async () => {
    const offer = await check("stable", "0.3.0-beta.4", [...RELEASES, "v0.2.0"]);
    expect(offer.offered).toBeNull();
    expect(kinds(offer)).not.toContain("available");
    expect(offer.updater.allowDowngrade).toBe(false);
    expect(offer.github.downloads().filter((request) => request.includes("beta"))).toEqual([]);
  });

  it("never offers a Preview client 0.3.0-beta.4 when it already runs 0.3.0-beta.5", async () => {
    const offer = await check("preview", "0.3.0-beta.5", RELEASES);
    expect(offer.offered).toBeNull();
    expect(offer.updater.allowDowngrade).toBe(false);
  });

  it("carries the offered version through the adapter into the update state", async () => {
    const { updater } = await newUpdater("0.3.0-beta.4", RELEASES);
    updater.autoDownload = false;
    const adapter = createUpdaterAdapter(updater as unknown as AutoUpdaterLike, () => undefined);
    const states: UpdateState[] = [];
    const policy = createUpdateController({ adapter, channel: "preview", onState: (state) => states.push(state), timers: createFakeTimers().timers });
    await policy.checkNow();
    expect(states).toEqual([{ kind: "checking" }, { kind: "downloading", version: "0.3.0-beta.5" }]);
  });
});

describe("a feed or check error", () => {
  const RELEASES = ["v0.3.0-beta.5", "v0.3.0-beta.4"];

  /** A Preview client on 0.3.0-beta.4 whose feed fails until `recover()`. */
  async function flaky(failure: "http" | "network") {
    const { updater, github } = await newUpdater("0.3.0-beta.4", RELEASES);
    updater.autoDownload = false;
    let failing = true;
    // The provider already holds this executor, so it is wrapped in place.
    const inner = github.executor.request.bind(github.executor);
    github.executor.request = async (request: { path?: string }) => {
      if (!failing) return inner(request);
      throw failure === "http" ? new HttpError(503, "unavailable") : Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), { code: "ERR_INTERNET_DISCONNECTED" });
    };
    const quitAndInstall = vi.spyOn(updater, "quitAndInstall");
    const adapter = createUpdaterAdapter(updater as unknown as AutoUpdaterLike, () => undefined);
    const states: UpdateState[] = [];
    const policy = createUpdateController({ adapter, channel: "preview", onState: (state) => states.push(state), timers: createFakeTimers().timers });
    return { policy, states, quitAndInstall, github, recover: () => void (failing = false) };
  }

  it.each(["http", "network"] as const)("(%s) gives the error state, installs nothing and is not an update", async (failure) => {
    const { policy, states, quitAndInstall } = await flaky(failure);
    await policy.checkNow();
    expect(policy.state()).toEqual({ kind: "error" });
    expect(states.at(-1)).toEqual({ kind: "error" });
    expect(policy.lastCheckedAt()).toBeNull();
    expect(policy.beforeQuit(false, 0, "complete")).toBe("none");
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it("lets the volunteer try again, and the retry finds the update", async () => {
    const { policy, recover, quitAndInstall } = await flaky("http");
    await policy.checkNow();
    expect(policy.state()).toEqual({ kind: "error" });
    recover();
    await policy.checkNow();
    expect(policy.state()).toEqual({ kind: "downloading", version: "0.3.0-beta.5" });
    expect(policy.lastCheckedAt()).not.toBeNull();
    expect(quitAndInstall).not.toHaveBeenCalled();
  });
});
