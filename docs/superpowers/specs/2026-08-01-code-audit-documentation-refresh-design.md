# Code Audit and Documentation Refresh Design

## Goal

Review the IPTV-Manager codebase for evidence-backed optimization opportunities,
apply only small low-risk improvements, and bring the README, configuration,
development, API, and performance documentation in line with the current
implementation.

## Current Evidence

- The repository contains 202 JavaScript files, 818 indexed functions, and 229
  indexed routes.
- The current baseline passes `npm run lint`, `DATA_DIR="$(mktemp -d)" npm test`
  (93 files, 611 tests), and `npm run build`.
- The largest indexed complexity hotspots are provider synchronization,
  streaming proxies, system import, EPG import, and Xtream authentication.

## Scope

### Direct code changes

1. Make the EPG scheduler safe against overlapping work from repeated timer
   ticks or duplicate scheduler starts. Track in-flight custom-source and
   provider updates by ID, clear an existing scheduler interval before starting
   a new one, and always release the in-flight marker in `finally`.
2. Make Redis stream-index cleanup conditional. Removing a stream must never
   delete a user/IP index that has already been replaced by a newer stream.

The public API, database schema, migration behavior, authentication contract,
stream URL behavior, and synchronization data model remain unchanged.

### Tests

- Extend the scheduler tests to cover duplicate/overlapping EPG ticks, cleanup
  after a successful update, and cleanup after a failed update.
- Extend the Redis stream-manager tests to cover removal of an old stream while
  the user/IP index points at a newer stream.

### Documentation

- Update `README.md` where setup, supported checks, Redis usage, or runtime
  configuration no longer matches the repository.
- Update `.env.example` to expose the supported runtime variables documented by
  the source and configuration reference.
- Update `docs/CONFIGURATION.md` and `docs/DEVELOPMENT.md` only from verified
  source, Docker, workflow, and package-script behavior.
- Reconcile `docs/API_REFERENCE.md` with the currently registered public routes
  and preserve its compatibility/security notes.
- Rewrite `docs/PERFORMANCE_ANALYSIS.md` so it describes the implemented
  optional Redis backend, the SQLite fallback, its current linear-scan behavior,
  and measured or testable follow-up work instead of presenting Redis as an
  unimplemented proposal.

No new dependency, migration, benchmark framework, or broad refactor is in
scope.

## Design

### EPG scheduler

`startEpgScheduler()` will own one interval handle. Starting it again clears the
previous handle. A small in-memory set will contain keys of the form
`custom:<sourceId>` and `provider:<providerId>` while their asynchronous update
is running. The scheduler skips only a key already in that set; independent
sources remain eligible. Each update adds its key immediately before awaiting
the service call and removes it in `finally`, preserving existing backoff,
database status checks, and error logging.

### Redis stream cleanup

`StreamManager.remove()` will fetch the stream payload as it does today, derive
the user/IP index key, and delete that index only when its current value equals
the stream ID being removed. It will still remove the stream hash entry and
local resource exactly as before. Redis errors remain contained by the existing
error handler.

## Error Handling

The scheduler continues to isolate custom-source and provider failures and
keeps provider backoff behavior. The in-flight marker is released for both
success and failure. Redis cleanup remains best-effort and does not turn a
cleanup race into a request failure.

## Verification

Run, in order:

```bash
npm run lint
npm exec vitest run tests/scheduler/sync_scheduler.test.js tests/managers/stream_manager_smart.test.js
DATA_DIR="$(mktemp -d)" npm test
npm run build
```

Then inspect `git diff --check`, the final diff, and `git status --short` to
ensure no runtime databases, secrets, caches, or temporary files are included.

## Explicitly Deferred Findings

- `performSync`, `importData`, `proxyLive`, `getXtreamUser`, and the EPG parser
  are high-complexity production paths. Their structural refactoring requires
  separate focused work with performance baselines and broader regression
  coverage.
- Redis connection counts and duplicate-session cleanup currently scan the
  stream hash. Replacing that with maintained secondary indexes would change
  Redis data semantics and is deferred until production measurements show the
  scan is a bottleneck.
- Dependency removal and broad repository cleanup are excluded because the
  current task needs behavior-verified improvements, not speculative deletion.
