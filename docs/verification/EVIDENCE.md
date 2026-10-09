# Verification & Evidence: Favor Printer UI Redesign (T4)

This document provides visual evidence, automated test verification, and macOS package verification for the Favor Printer app UI/UX redesign (T1–T4, Issue #7).

---

## 1. Automated Verification Checks & Results

The verification checks required by the test harness were run against the worktree:

| Check | Command | Result | Notes |
|---|---|---|---|
| **Dependencies** | `pnpm install --frozen-lockfile` | **PASS** | Dependencies resolved and up-to-date in 1.9s (pnpm v10.28.0) |
| **Lint** | `pnpm lint` | **PASS** | ESLint passed cleanly across all app and script files |
| **Typecheck** | `pnpm typecheck` | **PASS** | `tsc --noEmit` passed with 0 errors |
| **Test Suite** | `pnpm test` | **PASS** | 39 test files passed, 1003 tests passed, 1 skipped (1004 total) |
| **App Bundle** | `pnpm build` | **PASS** | `dist/main.js`, `dist/preload.js`, `dist/relay.js`, `dist/renderer` generated |
| **Vendor Integrity** | `pnpm verify:vendor` | **PASS** | `vendor/relay` matches `MANIFEST.json` byte-for-byte |
| **macOS Distribution** | `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist` | **PASS** | Packaging succeeded; arm64 & x64 DMG, zip, and app bundles built |
| **Smoke Packaged App** | `bash scripts/smoke-packaged.sh` | **PASS** | 6 passed, 0 failed against loopback stub cloud |

---

## 2. Command Output Logs

### `pnpm lint`
```text
> favor-printer@0.1.0 lint /Users/rico/.local/state/auto-office/worktrees/012d8d3b/T4
> eslint .
```

### `pnpm typecheck`
```text
> favor-printer@0.1.0 typecheck /Users/rico/.local/state/auto-office/worktrees/012d8d3b/T4
> tsc --noEmit
```

### `pnpm test`
```text
> favor-printer@0.1.0 test /Users/rico/.local/state/auto-office/worktrees/012d8d3b/T4
> VITE_CONFIG_NATIVE_IGNORE_WARNING=true vitest run --maxWorkers=2

 RUN  v5.0.3 /Users/rico/.local/state/auto-office/worktrees/012d8d3b/T4

 Test Files  39 passed (39)
      Tests  1003 passed | 1 skipped (1004)
   Start at  01:35:45
   Duration  3.51s (tests 73%, import 13%, transform 12%, worker 2%)
```

### `pnpm verify:vendor`
```text
> favor-printer@0.1.0 verify:vendor /Users/rico/.local/state/auto-office/worktrees/012d8d3b/T4
> node scripts/verify-vendor.mjs

vendor/relay matches MANIFEST.json
```

### `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist`
```text
> favor-printer@0.1.0 dist /Users/rico/.local/state/auto-office/worktrees/012d8d3b/T4
> pnpm build && electron-builder --publish never

built main: app/src/main/index.ts -> dist/main.js
built preload: app/src/preload/index.ts -> dist/preload.js
built relay: vendor/relay/embedded.ts -> dist/relay.js
built renderer: app/src/renderer -> dist/renderer
  • electron-builder  version=26.15.3 os=25.6.0
  • loaded configuration  file=electron-builder.yml
  • packaging       platform=darwin arch=arm64 electron=44.5.1 appOutDir=release/mac-arm64
  • skipped macOS application code signing  reason=, see https://electron.build/code-signing CSC_IDENTITY_AUTO_DISCOVERY=false
  • building        target=macOS zip arch=arm64 file=release/Favor-Printer-0.1.0-arm64.zip
  • building        target=DMG arch=arm64 file=release/Favor-Printer-0.1.0-arm64.dmg
  • packaging       platform=darwin arch=x64 electron=44.5.1 appOutDir=release/mac
  • skipped macOS application code signing  reason=, see https://electron.build/code-signing CSC_IDENTITY_AUTO_DISCOVERY=false
  • building        target=macOS zip arch=x64 file=release/Favor-Printer-0.1.0-x64.zip
  • building        target=DMG arch=x64 file=release/Favor-Printer-0.1.0-x64.dmg
```

### `bash scripts/smoke-packaged.sh`
```text
== checking packaged app: release/mac/Favor Printer.app
CFBundleIdentifier: church.favor.printer
ok   bundle id is church.favor.printer
CFBundleShortVersionString: 0.1.0
ok   version string is present
== codesign / spctl status
codesign: unsigned or invalid signature (honest report: expected for unsigned/PR builds)
spctl status: release/mac/Favor Printer.app: rejected
source=no usable signature
== verifying relay.js is present
relay.js confirmed present inside app.asar (dist/relay.js) via Electron runtime
ok   relay.js is present in the packaged app
== testing --self-test-relay against loopback stub cloud
loopback stub cloud listening on port 54821
binary output: {"type":"self-test","ok":true,"running":true,"cloud":"ok","stopOutcome":"stopped"}
ok   binary exited with 0
ok   self-test emitted json result line
ok   self-test JSON shows running+cloud ok and stopped via utilityProcess

6 passed, 0 failed
```

---

## 3. macOS Build Artifacts

Packaging produced the following unsigned artifacts in `release/`:

| Artifact | Architecture | Size | SHA-256 Checksum |
|---|---|---|---|
| `Favor-Printer-0.1.0-arm64.dmg` | Apple Silicon (`arm64`) | 122 MB | `982e802149b24e1d33a5d6451ad7d18f3b18f7d321d4fef1bc2d339f054f314f` |
| `Favor-Printer-0.1.0-arm64.zip` | Apple Silicon (`arm64`) | 122 MB | `85341a42a4bf8c894ff3a3fc208908513d9e90cba68320c40a8ce60937576c52` |
| `Favor-Printer-0.1.0-x64.dmg` | Intel (`x64`) | 126 MB | `ab2afe43575ff744d5bf1af7fa49b0e60a722942d79f7e8adf6f350a7107a3c1` |
| `Favor-Printer-0.1.0-x64.zip` | Intel (`x64`) | 126 MB | `d5881e7c1359645c58a97c286cfa6726bb543194d58f1996ecf14f7a75d27cc9` |
| `Favor Printer.app` | Apple Silicon (`arm64`) | App bundle | Located at `release/mac-arm64/Favor Printer.app` |
| `Favor Printer.app` | Intel (`x64`) | App bundle | Located at `release/mac/Favor Printer.app` |

---

## 4. Visual Evidence Gallery (`FIXTURE_NAMES`)

Screenshots were captured using `scripts/capture-screenshots.mjs` against the exact `520x640` setup window dimensions at 2x Retina resolution (`1040x1280` pixels). All fixture states contain only synthetic test fixtures and zero attendee or personal data.

| Fixture Name | Screen / State | Description | Screenshot |
|---|---|---|---|
| `default` | Welcome (`welcome`) | Welcome screen with 3-step numbered roadmap and "Get started" button | [screenshots/default.png](screenshots/default.png) |
| `no-printer` | Printer None (`printer`) | "Plug in your Zebra printer" prompt with "Look again" action | [screenshots/no-printer.png](screenshots/no-printer.png) |
| `several-printers` | Printer Choice (`printer`) | Radio picker for multiple connected Zebra printers (ZD421, GK420d) | [screenshots/several-printers.png](screenshots/several-printers.png) |
| `queue-fallback` | Printer Settings Guide (`printer`) | 3-step guidance when macOS refuses queue auto-setup | [screenshots/queue-fallback.png](screenshots/queue-fallback.png) |
| `enter-code` | Enter Code (`code`) | 6-digit PIN input with volunteer instructional copy | [screenshots/enter-code.png](screenshots/enter-code.png) |
| `invalid-code` | Code Invalid (`code`) | Inline banner: "That code did not work. It may have expired." | [screenshots/invalid-code.png](screenshots/invalid-code.png) |
| `connected` | Connected (`connected`) | Enrolled confirmation with green status badge | [screenshots/connected.png](screenshots/connected.png) |
| `test-print-confirm` | Test Print Prompt (`test-print`) | Verification step: "Did a label come out?" | [screenshots/test-print-confirm.png](screenshots/test-print-confirm.png) |
| `revoked` | Laptop Revoked (`revoked`) | Red status banner and volunteer instructions to contact an admin | [screenshots/revoked.png](screenshots/revoked.png) |
| `legacy-relay` | Replace Old Relay (`welcome`) | Migration step detecting the old launchd print relay | [screenshots/legacy-relay.png](screenshots/legacy-relay.png) |
| `legacy-confirm` | Confirm Relay Migration (`welcome`) | Confirmation prompt to turn off the old relay daemon | [screenshots/legacy-confirm.png](screenshots/legacy-confirm.png) |
| `legacy-failed` | Relay Migration Failed (`welcome`) | Error banner when old relay daemon cannot be unloaded | [screenshots/legacy-failed.png](screenshots/legacy-failed.png) |

---

## 5. Security & Privacy Certification

- **Zero Secrets**: No tokens, private keys, passwords, or cloud credentials are included in screenshots or logs.
- **Zero Personal Data**: All rendered labels use generic fixture data (`Front desk laptop`, synthetic hardware serial numbers, and standard admin setup guidance).
- **Scope Compliance**: All changes are strictly isolated to `docs/verification/` and `scripts/capture-screenshots.mjs`.
