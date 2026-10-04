# Favor Printer

Favor Printer is the macOS menu-bar app that turns a USB Zebra printer on a volunteer's Mac into a
cloud-assigned check-in printer for [Favor RSVP](https://rsvp.favor.church).

Download and setup steps for volunteers: https://rsvp.favor.church/printer

## Repository layout

- `app/src/main`, `app/src/preload`, `app/src/renderer` — the Electron app (tracked in
  favorchurch/rsvp.favor.church#486 and favorchurch/favor-printer#1).
- `app/src/shared` — constants and the IPC and status types shared by main, preload and renderer.
- `vendor/relay/` — the print relay core, synced from the RSVP repository. Do not edit it here; changes
  land in the RSVP repository and arrive through the sync pull request. `SOURCE.json` records the source
  repo, path, commit sha and a sha256 per file, and `pnpm verify:vendor` fails when anything drifts or when
  `embedded.ts` is missing.
- `build/` — packaging resources (`entitlements.mac.plist`).
- `scripts/` — build, preview and vendor verification scripts.

Releases on this repository are the app's download and auto-update source.

## Development

Requires Node 22.12 or newer and pnpm 10 (`corepack enable`). Install with pnpm only.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

| Command | What it does |
| --- | --- |
| `pnpm build` | Bundles `dist/main.js`, `dist/preload.js`, `dist/relay.js` (from `vendor/relay/embedded.ts`) and `dist/renderer/` with esbuild. Main, preload and renderer are skipped, and reported, while their sources do not exist yet. A missing relay entry fails the build. |
| `pnpm preview:renderer` | Serves `dist/renderer` on http://localhost:4173 (loopback only, no dependencies). Open `/index.html?state=<name>` for a fixture state. Run `pnpm build` first. |
| `pnpm verify:vendor` | Checks `vendor/relay` against `SOURCE.json`. |
| `pnpm dist` | `pnpm build`, then electron-builder: `.app`, DMG and zip for arm64 and x64, plus `latest-mac.yml`, in `release/`. Never publishes. |
| `pnpm lint`, `pnpm typecheck`, `pnpm test` | ESLint, `tsc --noEmit`, Vitest. |

Everything the app runs is bundled into `dist/`, including `electron-updater`, so the package ships no
`node_modules` and the target Mac needs no Node, pnpm, tsx or git.

### Toolchain notes

- `typecheck` uses TypeScript 7 (`@typescript/native`). TypeScript 7 ships no JavaScript API yet, and
  typescript-eslint needs one, so `typescript` itself is aliased to `@typescript/typescript6` for the
  linter. Drop the alias once typescript-eslint supports TypeScript 7.1.
- Electron has no install script. It downloads its binary on first run, and electron-builder downloads its own copy.
- Versions are pinned exactly. Bump them deliberately and commit the lockfile.

## Signing and notarization

`electron-builder.yml` reads credentials from the environment, so one config serves both unsigned and signed builds.

- Unsigned build (PRs, local checks): `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist`.
- Signing: `CSC_LINK` and `CSC_KEY_PASSWORD` for a Developer ID Application `.p12`.
- Notarization runs only when a credential set is present: `APPLE_API_KEY` (path to the `.p8`),
  `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
  Without one it is skipped with a warning.

The app runs with the hardened runtime and is not sandboxed, because it runs `lp` and `lpadmin`.
`build/entitlements.mac.plist` requests only `allow-jit` and `allow-unsigned-executable-memory`.
