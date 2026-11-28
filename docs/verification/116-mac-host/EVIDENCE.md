# #116 Mac-host validation: PR #118 durable-spool reconciliation install gate

Run: Office run 5d8bb593, task T1. Date: 2026-11-28 (log times are UTC, 05:09Z to 06:28Z for the first round, 07:17Z to 07:22Z for the fix round that added rows 2(c) and 10 overlap).
Scope of this file: records what was run on this Mac. Nothing was published, pushed, uploaded to a GitHub release or any feed, or sent anywhere. Detailed raw excerpts are in `logs/`. The exact helper scripts are in `RIG.md`.

## 1. Tested revision and host

| Item | Value |
| --- | --- |
| PR | favorchurch/favor-printer#118, branch `agent/116-reconciliation-install-gate` |
| PR head SHA tested | `2e8ce98b004bf3dd9cc22fdff511824441d622c4` (`gh pr view 118` headRefOid equals this worktree's HEAD; worktree clean before building) |
| Upstream RSVP source for the vendored relay | `3712cac918e031cc2ccbc46ffed394a349bdbe73` (rsvp#1276). `pnpm verify:vendor` reports `vendor/relay matches MANIFEST.json`. |
| Host | macOS 26.7.1 (25G241), arm64, Apple M5 Pro, Xcode 27.2 |
| Toolchain | node v26.13.1 (repo engines >=22.13), pnpm 10.28.0 (pinned), electron 44.5.1, electron-builder 26.15.3, electron-updater 6.8.9 |
| Local RSVP target | separate git worktree of `rsvp.favor.church` at `3712cac918e031cc2ccbc46ffed394a349bdbe73` under the scratch dir (never the RSVP main checkout, never prod or preview). Used only for `src/lib/printing/relayTestHarness.ts` `startStubCloud` (the real relay wire protocol over loopback HTTP). |

## 2. Tier 2 on this Mac (head 2e8ce98)

Run in this worktree after `pnpm install --frozen-lockfile` (exit 0). Full output: `logs/tier2-head-2e8ce98.txt`.

| Command | Exit |
| --- | --- |
| `pnpm verify:vendor` | 0 (`vendor/relay matches MANIFEST.json`) |
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test` | 0 (57 test files passed; 1577 tests passed, 1 skipped) |

The PR body reports 1,576 passed and 2 skipped. This Mac run counted 1,577 passed and 1 skipped. The totals match (1,578). One live-opt-in test counted as run instead of skipped here. It was not investigated further.

**Final re-run** with this evidence directory present, the final worktree state and `.scratch` moved out of the tree, `pnpm verify:vendor && pnpm lint && pnpm typecheck && pnpm test`: `verify:vendor` exit 0, `lint` exit 0, `typecheck` exit 0, `test` exit 0 (57 files passed, 1577 tests passed, 1 skipped).

## 3. Signed non-production test builds (never published)

All builds are Developer ID signed (`Developer ID Application: FAVOR CHURCH PH INC. (3JJ4492TV8)`, hardened runtime) with the dedicated release keychain, driven by `CSC_KEYCHAIN`. The keychain password was captured into a shell variable and never printed. **Notarization and stapling were not run** (`mac.notarize: false`, no `APPLE_*` variables; Apple services are not reachable from this environment). Consequently `spctl` rejects every artifact with `source=Unnotarized Developer ID`. That is expected for these builds and is not a signing failure: `codesign --verify --deep --strict` passes and the designated requirement is satisfied.

Test versions use the non-production prerelease identifier `test`. Production update configuration in tracked files is unchanged (`git status` shows only files under `docs/verification/116-mac-host/` from this task).

| Artifact id | Source | Version | Feed baked into the app | Role |
| --- | --- | --- | --- | --- |
| **P** (unmodified) | PR head 2e8ce98, no changes | `0.3.3-test.1` | `http://127.0.0.1:18101/` | primary artifact |
| P-target | same source | `0.3.3-test.2` | n/a | served by the local feed as the update |
| **S** (head+seam) | PR head 2e8ce98 plus the test seam in `logs/seam.diff` (scratch copy outside the repo, never committed or pushed) | `0.3.3-test.11` | `http://127.0.0.1:18102/` | scenario host |
| S-target | same as S | `0.3.3-test.12` | n/a | served by the local feed as the update |

Artifact file names and SHA256 (arm64 is the architecture that was run; x64 was built and signed by the same config but not executed):

```
P  0.3.3-test.1   arm64 dmg  e708ad124ec04ea510211f5221d1c98d49faeade6a3b940f30b6ef1e9d6bdae1  Favor-Printer-0.3.3-test.1-arm64.dmg
P  0.3.3-test.1   arm64 zip  c53868e538e2186873eccaa404c14203cdafd3e177efae70b2cfdaea60a5d14d  Favor-Printer-0.3.3-test.1-arm64.zip
P  0.3.3-test.1   x64   dmg  d05c6b13334d8a9e59dc5cca366f49dff82759c57b885b0f4414676d9d0b6224  Favor-Printer-0.3.3-test.1-x64.dmg
P  0.3.3-test.1   x64   zip  99a22f13becadf73b0b6209ddb3e3a91bb16f15f40971ba18ba750c1259d4f24  Favor-Printer-0.3.3-test.1-x64.zip
P  0.3.3-test.2   arm64 zip  73cc01553cef686283492910f10c24978547159e4848c19c7e7af506e64c121f  Favor-Printer-0.3.3-test.2-arm64.zip   (update target served to P)
S  0.3.3-test.11  arm64 dmg  06b955421ffbc9788d01d9665aa2eb08f4fe357c6d90bfceb0189e6a0e4ba713  Favor-Printer-0.3.3-test.11-arm64.dmg
S  0.3.3-test.11  arm64 zip  fffa26e5e120193aae0d9a4def496c146f29840e0519aaf6eebf3bfccafdaddd  Favor-Printer-0.3.3-test.11-arm64.zip
S  0.3.3-test.12  arm64 zip  eda91bdf79b74356990fba77a10328b092ff0815eca6f11734a4b253b82c7887  Favor-Printer-0.3.3-test.12-arm64.zip   (update target served to S)
```

The complete list (both archs, dmg and zip, manifests) is in `logs/artifacts.txt`.

Signing and Gatekeeper lines for **P arm64 0.3.3-test.1** (`logs/artifacts.txt` has the same for every build):

```
bundle-id=church.favor.printer  version=0.3.3-test.1  arch=arm64
codesign --verify --deep --strict --verbose=2 "Favor Printer.app"
  Favor Printer.app: valid on disk
  Favor Printer.app: satisfies its Designated Requirement
codesign -dv: Identifier=church.favor.printer  Format=app bundle with Mach-O thin (arm64)
  CodeDirectory v=20500 flags=0x10000(runtime)
  Authority=Developer ID Application: FAVOR CHURCH PH INC. (3JJ4492TV8)
  Authority=Developer ID Certification Authority
  Authority=Apple Root CA
  Timestamp=Nov 28, 2026 at 1:26:12 PM   TeamIdentifier=3JJ4492TV8
spctl --assess --type execute --verbose=4 "Favor Printer.app"
  Favor Printer.app: rejected   source=Unnotarized Developer ID   (exit 3, expected: not notarized)
codesign --verify --strict Favor-Printer-0.3.3-test.1-arm64.dmg
  valid on disk / satisfies its Designated Requirement (dmg signed)
spctl --assess --type open --context context:primary-signature  Favor-Printer-0.3.3-test.1-arm64.dmg
  rejected   source=Unnotarized Developer ID
xcrun stapler validate "Favor Printer.app"  ->  does not have a ticket stapled to it
```

### Build configuration used

Generated per build (scratch, never in the repo). It extends the tracked `electron-builder.yml` and overrides only the feed, version, output, notarization and targets. Shown for P `0.3.3-test.1`; the other builds differ only in `extends` (S builds extend the scratch copy), `version`, `output` and the feed port (18101 for P, 18102 for S).

```yaml
extends: $T1/electron-builder.yml
extraMetadata:
  version: 0.3.3-test.1
directories:
  output: $SCR/out-primary-1
publish:
  - provider: generic
    url: http://127.0.0.1:18101/
    channel: latest
mac:
  notarize: false
  target:
    - target: zip
      arch: [arm64]
    - target: dmg
      arch: [arm64]
dmg:
  sign: true
```

Command: `pnpm exec electron-builder --config <that file> --mac --arm64 --publish never` with `CSC_KEYCHAIN=~/Library/Keychains/favor-printer-beta6.keychain-db` and `APPLE_*` unset (full script in `RIG.md`). The merged base config also produced x64 artifacts.

### The test seam (head+seam artifact S only)

The packaged app hard-wires `https://rsvp.favor.church` (`app/src/main/shell/controller.ts:162`), and the production-only value is also used by the relay start gate, so no unmodified build can reach a local relay. The orchestrator approved a seam applied only in a scratch copy: an env var `FAVOR_PRINTER_TEST_API_URL` accepted only as an `http://127.0.0.1:<port>` or `http://localhost:<port>` origin and ignored otherwise (the start gate now passes the same resolved value). With the variable unset the behavior is identical to the PR head. It is not in the repo and was not pushed. The product follow-up to make the API URL configurable is out of scope.

```diff
--- a/app/src/main/shell/controller.ts	2026-11-28 13:10:10
+++ b/app/src/main/shell/controller.ts	2026-11-28 13:31:22
@@ -156,10 +156,23 @@
 const ASLEEP_WARNING = "This computer went to sleep. Labels wait until it wakes.";
 const LOCKED_WARNING = "The screen is locked. Keep the lid open so printing is not interrupted.";
 
+/** TEST SEAM (never committed): accepts only an http://127.0.0.1:<port> or http://localhost:<port> origin, ignores anything else. */
+function testApiUrl(raw: string | undefined): string | undefined {
+  if (!raw) return undefined;
+  try {
+    const url = new URL(raw);
+    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
+    if (url.protocol !== "http:" || !loopback || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
+    return url.origin;
+  } catch {
+    return undefined;
+  }
+}
+
 export function createAppController(deps: ControllerDeps): AppController {
   const { prefs, secrets, printers, legacy, log } = deps;
   const timers = deps.timers ?? systemTimers;
-  const apiUrl = deps.apiUrl ?? "https://rsvp.favor.church";
+  const apiUrl = deps.apiUrl ?? testApiUrl(process.env.FAVOR_PRINTER_TEST_API_URL) ?? "https://rsvp.favor.church";
   const isWindows = deps.platform === "win32";
 
   let enrolled = false;
@@ -238,7 +251,7 @@
     appSupportDir: deps.appSupportDir,
     appVersion: deps.version,
     osVersion: deps.osVersion,
-    apiUrl: deps.apiUrl,
+    apiUrl,
   });
 
   const backlogMonitor = new BacklogMonitor();
```

## 4. Test environment, isolation and safety

| Item | What was done |
| --- | --- |
| Feed | Two local-only generic feeds on loopback (`18101` serving P-target, `18102` serving S-target). A tiny static server logged requests. Nothing was uploaded anywhere. |
| Relay target | RSVP's `startStubCloud` (rsvp@3712cac) on loopback with a throwaway relay id and a harness-only fake token. No production RSVP enrollment or credentials. Synthetic ZPL only (`^XA...T1 SYNTHETIC...^XZ`), never private label content. |
| CUPS | Temporary non-physical queue `FP_T1_Test_Queue` backed by a loopback socket sink that counts and hashes bytes. Created with `lpadmin -p FP_T1_Test_Queue -E -v socket://127.0.0.1:19100 -m drv:///sample.drv/zebra.ppd`. Deleted at the end with `cancel -a FP_T1_Test_Queue` and `lpadmin -x FP_T1_Test_Queue` (exit 0). The default destination (`Zebra_Technologies_ZTC_ZD421_203dpi_ZPL`) was never changed. Its queue only lists old October jobs. Nothing was submitted to it and its settings were not touched. No Zebra is attached to this Mac (`lpinfo --include-schemes usb -v` was empty). |
| App data isolation | Every test app ran with a throwaway `HOME` (`os.homedir()` decides `userData`) that symlinks only `Library/Keychains` (without it Electron safeStorage is unavailable). The test profile carried a safeStorage-encrypted throwaway token and a seeded `prefs.json`. |
| Keychain | Item `favor-printer Safe Storage` already existed (created 2026-10-07 by an earlier real run). It was reused, not created or deleted. (An earlier check in this run searched the wrong service name and reported it absent. That was wrong.) The real app-data dir has no `relay-token.bin`, so no production pairing exists on this Mac. |
| Observation taps | The app was started with `--inspect-brk`. A read-only tap logged relay status messages (state, reconciliation, inFlight, counts, error code, no ids or content), relay spawn/exit and quit events. Add-only listeners, no behavior change. The renderer API was read through `--remote-debugging-port` (`getSnapshot`, and `quit()` which is the tray Quit path). |

### Real app data before and after (hash proof)

Before running anything: the real `~/Library/Application Support/Favor Printer` existed (Chromium caches, `prefs.json` with `revoked: true`, an empty `spool/`, no `relay-token.bin`, app not running). A manifest was taken (every file SHA256, symlink targets, mode, size and mtime for every path: 142 lines) and the dir was backed up with `ditto` (backup file hashes matched).

- Manifest SHA256 before: `bab20d7890848dcd4110eaa5c3d27ac37cdc946dc58e46d5a08a42be5099e858`
- Manifest SHA256 after restore: `bab20d7890848dcd4110eaa5c3d27ac37cdc946dc58e46d5a08a42be5099e858` (equal, `REAL_APP_DATA_IDENTICAL_TO_BEFORE`)

What changed in between, and the restore: after every install the Squirrel/ShipIt relaunch starts the new version **with the real `HOME`** (ShipIt does not inherit the throwaway `HOME`; confirmed with `ps eww`: `HOME=/Users/<user>`). Each such relaunched app was killed straight after it came up. Those launches only wrote Chromium cache files (GPU/Dawn caches, `Local Storage`/`Session Storage` logs, `DIPS-wal`, Singleton symlinks, `blob_storage`). `prefs.json`, `spool/` and every other tracked-by-the-app file were never modified (no relay ran: no token, `revoked: true`). Restore: `rsync -ac --delete <backup>/ <real dir>/` plus `touch -h` to reset the three Singleton symlink mtimes (the first non-checksum pass skipped three memory-mapped cache index files whose content changed without a size or mtime change; the checksum pass fixed them).

Other real-home side effects, all reverted:

| Location | Effect | Reverted |
| --- | --- | --- |
| `~/Library/Logs/favor-printer/main.log` (the app logs to the real home regardless of `HOME`) | the test runs appended 76 lines in total (6 of them from early probe launches made before the log was backed up) | restored to the original content: SHA256 `d80511dd7f90982ac7e40b7ba28f4b78b62b6dce59b52afdd4ca630ec88d957e` before and after (mtime reset to the original 2026-11-13 11:08). The appended lines are kept in `logs/app-main-log-lines-during-runs.txt`. |
| `~/Library/Caches/favor-printer-updater/pending/` | used by electron-updater for the test downloads | empty again (same as before the run) |
| `~/Library/Caches/church.favor.printer/` and `church.favor.printer.ShipIt/` | did not exist before, created by the relaunched apps and ShipIt | moved out to the scratch dir |
| `~/Library/Preferences/church.favor.printer.plist` | unchanged (mtime 2026-10-07) | n/a |
| login keychain | no item added or removed | n/a |
| `launchctl setenv` | not used | n/a |

### Fix round (07:17Z to 07:22Z): same isolation and restore

The fix round repeated the same procedure: a new manifest of the real app-data dir (SHA256 `bab20d7890848dcd4110eaa5c3d27ac37cdc946dc58e46d5a08a42be5099e858`, equal to the first round's), the same loopback stub cloud, sink, feed and temporary CUPS queue (re-created with the same `lpadmin -p FP_T1_Test_Queue -E -v socket://127.0.0.1:19100 -m drv:///sample.drv/zebra.ppd`, deleted again with `cancel -a FP_T1_Test_Queue` and `lpadmin -x FP_T1_Test_Queue`, exit 0). One run installed an update (10 overlap, variant B), so one ShipIt relaunch ran with the real `HOME` and was killed at once. Afterwards the real app-data dir was restored with `rsync -ac --delete` from the same backup and its manifest SHA256 is again `bab20d78...e858`. The real app log was restored to SHA256 `d80511dd7f90982ac7e40b7ba28f4b78b62b6dce59b52afdd4ca630ec88d957e` (the 12 lines the fix round appended are in `logs/app-main-log-lines-fix-round.txt`). The two cache dirs ShipIt re-created under `~/Library/Caches` were moved out, and `favor-printer-updater/pending/` is empty. The RSVP worktree used for the stub was re-created at `3712cac918e031cc2ccbc46ffed394a349bdbe73` and removed again.

## 5. Scenario results

Scenario numbers follow the #116 / PR #118 continuation list. "Artifact" says which build ran the row. Raw excerpts are named in the last column. Observation taps and the app log show these updater and quit facts directly: the update state `ready` readout (from `getSnapshot`), the relay's `reconciliation` status as the app received it, `quit without installing: ...` log lines, and the bundle's `CFBundleShortVersionString` after the quit.

| # | Artifact | Setup | Action | Expected | Observed | Result | Evidence (logs/) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | S | Throwaway profile whose spool holds a persisted `claimed` entry left by an earlier process (the process was quit while waiting on the cloud `/sending` answer). Stub cloud `/hold-sending` on so the entry cannot resolve. Update `0.3.3-test.12` downloaded. | Start a NEW process, wait for update `ready`, then quit from the renderer (tray Quit path). | Relay counts show zero claims for this run, reconciliation stays pending because of the persisted entry, the update stays ready and is not installed. | Counts `claimed:0` in every sample, reconciliation `pending` in all 15 samples (never `complete`), snapshot `update.kind: ready (0.3.3-test.12)`. Quit: relay stopped with reconciliation `pending`, app exited, bundle stayed `0.3.3-test.11`. The entry is preserved (same name hash and content, stage `claimed`). | PASS | S1-persisted-work; S9-spool-residue (same behavior with residue files) |
| 2 | S | (a) update ready, relay child frozen with `kill -STOP` (it stops answering). (b) update ready, relay running, spool dir given an ACL deny entry so the inventory read fails. (c) older relay: update ready, relay running and healthy, but every relay status message reaches the app **without** the `reconciliation` field. | (a) quit. (b) `chmod +a "user:<me> deny list,search" <spool>`, wait, quit, then `chmod -a`. (c) the app was started with `--inspect-brk` and a scratch hook (`logs/fault-hooks.diff`) that removes `reconciliation` from every status message at the main-process message boundary, which is exactly what a relay that predates the field would send (the sanitizer only ever sees what the wire carries). A one-shot injected message would be overwritten by the next real status 2 s later, so the strip is persistent. Quit from the renderer. | Unknown or silent status and an interrupted or unreadable reconciliation defer the install. | (a) after about 13 s the stop wait ended: log `quit without installing: the relay did not stop cleanly`, bundle stayed test.11. (b) relay logged `unexpected failure` and `cycle failed`, reconciliation went and stayed `pending`, stop reported `pending`, app quit without install, bundle stayed test.11, ACL removed afterwards. (c) the relay really posted `complete` 24 times and `pending` 36 times in 6 s, and the app received 30 status messages, every one with `reconciliation=undefined`. Update was `ready`. At quit the relay stopped cleanly (`stopping`, `stopped`, bare `stopped`; raw value `complete`), but the app did not install: no updater events, app exited, bundle stayed test.11. Control: with the field present the same signed build installs (row 5). | PASS for (a), (b) and (c) | S2-S10 (2a, 2c); S4-timeout-kill; S2-older-relay-missing-field; fault-hooks.diff |
| 3 (OS-spool half) | S | Update ready. Stub `/hold-sending`, one synthetic job enqueued. The relay started its `lp` child, then the `lp` child was frozen (`kill -STOP`) while the cloud hold was released, so the relay is in the write phase (`inFlight=true`). | Quit from the renderer while in flight. After 4 s confirm the app is still waiting, then `kill -CONT` the `lp` child. | The app waits, the job reaches CUPS and the sink before shutdown, the relay reports it, stops clean, and the update installs. | App alive 4 s after quit with status `stopping inFlight=true`; sink had no new bytes while stalled. After resume: sink `CONN 2 bytes=32`, CUPS queue empty (`lpstat -o` 0 pending), relay `sent:1`, stub got report `sent`, reconciliation `complete`, `stopped`, ShipIt installed, bundle became test.12, spool empty. A first attempt (quit while still waiting on the cloud answer) correctly aborted the unsent job instead: it stayed `claimed`, reconciliation `pending`, no install. | PASS (paper NOT RUN) | S3-inflight-then-install |
| 4 | S | Update ready, relay frozen with `kill -STOP` so it cannot post `stopped`. | Quit from the renderer. | Stop wait times out, relay is killed, app quits without installing, update stays downloaded. | App exited about 13 s after the request. Log: `quit without installing: the relay did not stop cleanly`. No updater events. Bundle stayed test.11. The next launch showed `ready` again (row 6). | PASS | S4-timeout-kill |
| 5 | S | Enrolled throwaway profile, relay idle with reconciliation `complete`, update ready. | Quit from the renderer. | Relay stops clean with a fresh stopped status and reconciliation `complete`, the update installs exactly once. | Tap: `stopping complete` then `stopped complete`, then native updater `checking, available, downloaded`, app quit. Bundle test.11 became test.12. ShipIt logged one `Beginning installation / Installation completed successfully` pair for this run (13:53). The relaunched test.12 started once (`Favor Printer 0.3.3-test.12 started`, one log line). It was killed immediately (it ran with the real HOME, section 4). | PASS | S5-clean-install; ShipIt-log-summary |
| 6 | S | Continues row 4: same install and profile, update deferred earlier. | Relaunch, wait for ready, quit from the renderer. | The previously deferred download installs on the next clean quit. | After the relaunch the snapshot showed `ready (0.3.3-test.12)` with no new download. Quit: relay `stopped complete`, update installed, bundle test.11 became test.12 (about 21 s). ShipIt one install at 13:57. | PASS | S6-later-clean-quit |
| 7 | S | Relay running, reconciliation `complete`. | `kill -9` the relay child (unexpected exit while the app keeps running). | The restarted relay does not inherit completion. | Relay exit code 9, supervisor restarted it after about 1 s. The first statuses of the new relay were `starting reconciliation=pending` and `running reconciliation=pending`. `complete` only returned after the new relay completed its first inventory. | PASS | S7-relay-restart |
| 8 | S | Stub `/hold-sending`, a job in flight so the spool has `<job>.json` (stage `sending`, no payload) and `<job>.send`. | `kill -9` the app and the relay (crash), then start again. | The `sending` record is never replayed to the printer. | After restart the relay reported the job `ambiguous` to the cloud (counts `ambiguous:1`), the loopback sink received nothing new (still 2 connections, none for this job), the spool was cleared only by that report, the log shows `job ambiguous`. | PASS | S8-sending-never-replayed |
| 9 | S | Hand-made spool: a corrupt record, an orphan `.send` marker, an unknown file, a temp-looking file. Plus, for the unreadable inventory, see row 2(b). Update ready. | Start the app twice, quit each time. | Residue is preserved and keeps reconciliation pending across restarts, so the update never installs. | Round 1 and 2: `pending` in all 7 samples each, never `complete`. The corrupt record was renamed to `.corrupt` with identical content hash; the `.send`, unknown file and non-matching temp file are byte-identical after each round (name hashes and content hashes in the log). Both quits ended without install, bundle stayed test.11, update `ready` again after the restart. Exception: a temp file named `*.json.<pid>.<uuid>.tmp` was deleted by the existing crash-sweep at relay start (observation 2). | PASS, with observation 2 | S9-spool-residue |
| 10 | S | Update ready, relay idle and complete. ACL deny-delete on `<spool>/.relay.lock` so releasing the lock fails. | Quit from the renderer; remove the ACL afterwards. | A failed lock release must not report complete. | Tap: `stopping complete`, then `stopping reconciliation=pending`, then the bare `stopped` message, with no later `complete`. The lock file stayed in place, the app exited, bundle stayed test.11. | PASS (failed release) | S2-S10 (S10)
| 10 (overlap) | S | Update ready, relay idle. Relay child inspector enabled with `kill -USR1 <relay pid>`; a scratch debugger client (`relay-bp.mjs`, in `RIG.md`) sets a breakpoint on the claim stage inside the relay's `runTick` and one on the `finally` block of `runTick` (lines 1147 and 1153 of `dist/relay.js` inside the signed asar). Variant A adds an ACL deny-delete on `<spool>/.relay.lock`; variant B (control) has none. | Wait until the relay child is frozen inside a running work cycle (relay `halted:false`), request quit from the renderer, wait 2 s (app still alive, no relay message arrived), then release the breakpoint. | The stop request overlaps a running work cycle. The cycle must not publish `complete` once stop began. With a failed lock release (A) completion stays pending and no install happens. With a successful release (B) completion is published only by the shutdown and the update installs. | Breakpoint 1 hit with `{"halted":false,"stopped":false,"accepting":true}`. The queued stop was processed right after the release: breakpoint 2 (tick `finally`, before the cycle computes its completion signal) hit with `{"halted":true,"stopped":true,"accepting":false}`, proving the stop began while the cycle was still running. A: relay posted `stopping reconciliation=pending`, then the bare `stopped`, never `complete`; lock left in place; app exited; bundle stayed test.11. B: `stopping pending` (the overlapped cycle did not publish `complete`), then `stopping complete`, `stopped complete` from the shutdown after lock release, then the native updater downloaded and installed; bundle became test.12; spool empty. | PASS (A and B) | S10-overlap-with-running-cycle; fault-hooks.diff |
| 11 | S | (a) Update ready, relay complete (pre-shutdown completion exists). (b) same, then a bare `{type:"stopped"}` message injected into the supervisor handler through the inspector while the real relay is frozen. (c) in-flight write stalled, relay frozen after the stop request so the stop wait is abandoned. | (a) freeze the relay, quit, then `kill -9` it two seconds later. (b) freeze, quit, inject. (c) quit, wait 13 s (past the 10 s stop wait), then `kill -9` the relay. | Unexpected exit or a bare stopped acknowledgement cannot reuse pre-shutdown completion, also after an abandoned stop wait. | (a) app exited right after the relay exit, no updater events, bundle stayed test.11. (b) app exited, no updater events, bundle stayed test.11. (c) app was still alive and the relay not killed 13 s after the quit (abandoned wait), then exited after the kill with no updater events, bundle stayed test.11 after 30 s; the spool kept the `sending` entry, `.send` marker and stale lock. | PASS | S11-unexpected-exit |
| P1 | P (unmodified, 0.3.3-test.1) | n/a | `bash scripts/smoke-packaged.sh <P app>` (runs `--self-test-relay` against a loopback stub cloud). | Signed bundle valid, relay inside the asar, self-test starts and stops the relay cleanly. | 6 passed, 0 failed. `{"type":"self-test","ok":true,"running":true,"cloud":"ok","stopOutcome":"stopped"}`. codesign valid, spctl rejected as unnotarized (reported honestly by the script). | PASS | P1-smoke |
| P2 | P (unmodified, 0.3.3-test.1) | Throwaway profile (not enrolled), feed on 18101 serving 0.3.3-test.2. | Launch, wait for the update, read the snapshot, quit from the renderer. | Update detected and downloaded from the local feed only. | Feed log: `GET /latest-mac.yml 200`, `GET .../Favor-Printer-0.3.3-test.2-arm64.zip 200`. Snapshot `update: {kind: "ready", version: "0.3.3-test.2"}`. Quit with no relay: app exited, bundle stayed test.1 (observation 1). | PASS (detect/download), install not applicable without a relay | P2-primary-update |


### Scenario 3 paper output and other items not run

| Item | Status | Reason |
| --- | --- | --- |
| Scenario 3, label paper output | NOT RUN | needs a physical Zebra. This Mac has none attached. The OS-spool half ran against a non-physical CUPS queue and proves only that CUPS accepted the job and delivered bytes to the loopback sink. It is not proof that a label printed. |
| Any label-path check that needs a physical Zebra | NOT RUN | same reason. To be covered by the separate physical Zebra issue. |
| Scenario 2, older relay without the `reconciliation` field | RAN (emulated) | a real older relay binary cannot run inside the signed app (the relay lives in the signed asar). The field was removed from every status at the main-process message boundary, which is what an older relay's wire messages look like. The sanitizer, supervisor, controller and quit coordinator are the signed build's own code. |
| Scenario 10, work cycle overlapping the stop | RAN | forced deterministically with debugger breakpoints in the relay child (see the row). The breakpoints are a timing and observation tool only and change no logic. |
| P (unmodified artifact): enrolled relay scenarios | NOT RUN on P | P cannot reach a local relay. Those ran on S. |
| Notarization, stapling, Gatekeeper first-open | NOT RUN | Apple services are unreachable here. |
| x64 artifacts | built and signed, not executed | this Mac is arm64. |

## 6. Observations to carry forward (none is a scenario FAIL)

1. **An app with no running relay never installs an update.** With P (not enrolled, so the relay never starts and reconciliation stays `pending`) the update shows `ready` but quit never installs (P2). This is consistent with the fail-closed design, but a Mac that is unenrolled or revoked can never self-update. That is a product decision for the owner. No change was made.
2. **Crash-orphaned temp writes are swept at relay start.** In scenario 9 the temp file named like `*.json.<pid>.<uuid>.tmp` was deleted by `sweepOrphanedWrites` (existing relay code, `vendor/relay/spool.ts`) before the inventory. Every other residue (quarantined `.corrupt`, orphan `.send`, unknown file, a non-matching `.tmp`) was preserved byte for byte. The PR text says orphan send/temp files are preserved. The sweep is pre-existing behavior and removes only unrenamed crashed writes, but it is a small gap against that sentence.
3. **`chmod 000` on the spool dir is not an unreadable inventory.** The relay re-asserts mode 0700 (`spool.ts:327`) every cycle, so reconciliation completed and the update installed (logged in `logs/S2-S10.txt`). A macOS ACL deny entry did produce a real read failure (scenario 2).
4. **A stopped `lp` can be timed out by the relay instead of staying in flight.** The relay's own 10 s write timeout beat the 10 s stop wait in one attempt. The job was reported `ambiguous`, the relay then stopped cleanly with reconciliation `complete`, and the update installed (a recorded outcome counts as settled). Not a defect, but it means an "abandoned" wait needs the relay frozen as in scenario 11c to be reproduced.
5. **The repo's e2e harness is stale against rsvp@3712cac.** `e2e/harness-server.ts` imports `createLayeredRelayRegistry`, which no longer exists in `src/lib/printing/relayAuth.ts`, so `RUN_LIVE_E2E` cannot start the cloud harness. This run used RSVP's own `startStubCloud` instead. Not touched (out of scope).
6. **A keychain lookup mistake during setup** (wrong service name) is corrected in section 4.
7. **Early probe launches** (throwaway `HOME`, made while working out the rig) appended 6 lines to the real app log before it was backed up. The restored log is the original: the backup was cut at the last pre-probe entry (line 2,784, timestamp 2026-11-13T03:08:18Z) and its SHA256 matches before and after.

## 7. Reproduction

The helper scripts are in `RIG.md`. Short form: build P and P-target and S and S-target with the config above, serve the target builds from the two loopback feeds, install the older build with `ditto` into a scratch dir, seed a throwaway `HOME` (prefs plus a safeStorage token via the `--inspect-brk` seed tap), start the stub cloud (`CTL_PORT=19400`, which also sets the printer address so the relay is allowed to send) and the CUPS sink, then run the row's fault injection and quit through the renderer IPC.
