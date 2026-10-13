# Agent instructions

## Testing

- **What to test:** behavior, contracts, invariants and state transitions (printer lifecycle, backlog, status reducer, IPC and relay contracts). No snapshots and no tests that mirror the implementation. Technique: fast-check model-based tests ([favor-printer#9](https://github.com/favorchurch/favor-printer/issues/9), [rock-steward#156](https://github.com/favorchurch/rock-steward/issues/156)). Write deep properties for touched business-rule modules and as pre-merge proof; routine changes get ordinary example tests.
- **Setup:** package root is the repo root (`package.json`, `pnpm-lock.yaml`). Node >=22.13 (CI pins 22.13.0), pnpm 10 via `corepack enable`. Install with `pnpm install --frozen-lockfile`.
- **Tier 1, changeset checks:** `pnpm exec vitest run <path>` for the files you touched, then `pnpm typecheck`.
- **Tier 2, PR-ready proof:** `pnpm lint && pnpm typecheck && pnpm test`. All three must exit 0.
- **Tier 3, post-merge or deep runs:** raise property depth with `FC_NUM_RUNS=<n> pnpm test` (default 200 per property, from `app/src/shared/testing/property.ts`). Run `pnpm dist` for the unsigned build that CI also runs.
- **Tier 4, real data or credentials:** none in the Vitest suite. The only live test (`scripts/e2e-relay-sim.test.ts`) is skipped unless `RUN_LIVE_E2E` is set and targets a local RSVP checkout, never prod. Signing, notarization and real-printer checks are manual and outside the suite.
- **Replay a fast-check failure:** properties use the fixed `PROPERTY_SEED`, so rerun the same file. To replay a reported counterexample, set the printed values: `FC_SEED=<seed> FC_PATH="<path>" pnpm exec vitest run <file>`.
- **iOS:** `ios/` tests run in Xcode separately and are not part of `pnpm test`.
- **Boundaries:** tests never touch real printers, RSVP prod, signing secrets or other privileged secrets. There are no Rock or database reads or mutations here, and no Python or Deno code, so those guards do not apply. Keep the existing safety guards: `privacy.test.ts` (no PII in logs or UI), the secret-scan and vendor-check workflows, and the no-secrets CI job.
- **CI:** `.github/workflows/ci.yml` is canonical. It runs on `macos-latest`: install, lint, typecheck, test and an unsigned `pnpm dist`. Results appear in the GitHub Actions run for the PR.
- **Actions availability (checked 2026-10-13 with `gh api repos/favorchurch/favor-printer/actions/permissions`):** Actions is enabled but `allowed_actions` is `local_only`, so workflows that use marketplace actions currently end in `startup_failure`. Re-check with the same `gh api` command before relying on this. Until that changes, the test receipt is the local Tier 2 output quoted with its exit code in the PR or issue. Once Actions runs, the receipt is the PR's Actions run.
- **Ownership:** [rock-steward#157](https://github.com/favorchurch/rock-steward/issues/157) owns CI cadence, caching, runner and action permissions, required-check semantics and rollout. This is the single canonical testing section. Do not add a second one in CLAUDE.md or README.md.
- **Not allowed as checks:** `--passWithNoTests`, `--fix` commands, or scripts that are not in `package.json`.
