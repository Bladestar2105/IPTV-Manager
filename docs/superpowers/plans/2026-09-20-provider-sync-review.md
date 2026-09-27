# Provider sync review implementation plan

> **For agentic workers:** Use test-first execution for each independent finding; coordinate ownership before editing shared files.

**Goal:** Close the four review gaps against current main, preserve existing assignments, and report current production evidence.

**Architecture:** Keep network downloads outside SQLite transactions. Validate authorization, configuration and mapping state after acquiring the catalog writer lock. Keep episode storage shared by source while preserving the eligible account candidates for each series.

**Tech Stack:** Node.js, Express, better-sqlite3, node-fetch, Vitest; existing Docker/Compose smoke checks.

**Spec:** User review request of 2026-09-20, findings 1–4 against `5cfa5b02ee49a11e713bf75829a730c173a84fd0`, plus read-only production audit and Codebase Memory ADR.

## Constraints

- Worktree branch `codex/provider-sync-review-fixes`; preserve the original checkout and untracked test.
- No dependencies, schema migration, automatic permission expansion, merge, release or production deployment.
- Preserve channel/user IDs, customizations, encrypted credentials and configuration.
- Test databases and browser smoke servers use isolated temporary directories.

## Review focus

- A writer must observe grant, owner and administrator-session changes committed during its SQLite wait.
- A concurrent category-owner change must not redirect or restore assignments using a stale mapping.
- Changes to URL, credentials, user agent or backup URLs invalidate the catalog; expiry bookkeeping does not.
- A local episode DB error must not trigger credential fallback or a source cooldown.
- Identical series IDs may retain several eligible accounts without changing source-shared protocol output.

## Tasks

1. **Catalog authorization and configuration** — `src/services/syncService.js`, `src/controllers/providerController.js`, `tests/sync_authorization_atomicity.test.js` and existing sync fixtures.
   - [x] Read controller, routes, schema, callers and current transaction boundary.
   - [x] Add a real second SQLite writer using a worker-thread barrier; observe failures before edits.
   - [x] Pause catalog downloads and change fetch settings with the owner unchanged; observe rejected expectations before edits.
   - [x] Revalidate the authenticated manual actor and per-provider grant inside `immediateTransaction`; reload mappings and assignments there.
   - [x] Compare a SHA-256 fingerprint of stored fetch configuration before catalog writes; decrypt a separate fetch copy.
   - [x] Run `npm test -- tests/sync_authorization_atomicity.test.js tests/sync_service_regression.test.js tests/sync_status_reporting.test.js tests/functional/sync_service_category_update.test.js tests/perf_sync_update.test.js tests/provider_lock.test.js`.
2. **Episode fallback and HTTP cleanup** — `src/services/seriesSyncService.js`, `tests/series_episode_sync_backoff.test.js`, `tests/series_episode_response_cleanup.test.js`.
   - [x] Reproduce identical-ID account failures and never-ending HTTP error responses before changes.
   - [x] Preserve eligible candidates, retry upstream failures, retain local DB-failure separation and count logical-series outcomes.
   - [x] Call `discardBody` before throwing on a refused response.
   - [x] Check actual sockets, requests, responses and timer cleanup through on-demand and batch entry points.
3. **Production evidence and architecture record**.
   - [x] Read-only SSH inspection of the deployed revision, retained container logs, resource usage and data-file sizes.
   - [x] Store a sanitized report; distinguish current observations from PR #628's historical claims.
   - [x] Persist verified architecture and the database-engine recommendation with `manage_adr`.
4. **Final validation and review**.
   - [x] Independent review of the focused diff and regression coverage.
   - [x] Full `npm test`, `npm run lint`, `npm run build` and JavaScript/template syntax validation.
   - [x] Run available Compose, Docker runtime and browser smoke checks; label unavailable external integrations explicitly.
   - [x] Deliver per-finding cause, change, tests and limits with source lines; leave production unchanged.
