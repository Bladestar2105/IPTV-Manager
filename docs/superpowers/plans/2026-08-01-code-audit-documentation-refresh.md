# Code Audit and Documentation Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax (- [ ]) for tracking.

**Goal:** Apply the reliability/performance fixes discovered by the audit, reduce EPG batch allocations, cache repeated Xtream episode lookups in both playlist variants, simplify export assembly, cache repeated statistics lookups, isolate provider catalog fetching and import input preparation from their controllers, and synchronize user and maintainer documentation with the current IPTV-Manager implementation.

**Architecture:** Keep the existing Express routes, SQLite schema, Redis key layout, and service boundaries. Add scheduler-local in-flight state, reusable EPG batch buffers, request-local Xtream episode caches, a conditional Redis secondary-index delete, direct export row assembly, a request-local statistics lookup cache, and private provider-catalog and import-preparation helpers; update documentation from verified package, source, route, Docker, and workflow behavior.

**Tech Stack:** Node.js 24+, Express 5, better-sqlite3, Redis client, Vitest 4, ESLint 10, Markdown.

## Global Constraints

- Preserve public API responses, stream URLs, authentication behavior, database IDs, migrations, and Docker compatibility.
- Do not add dependencies or change the SQLite schema.
- Use npm and isolate database-touching tests with DATA_DIR.
- Do not stage databases, secrets, caches, uploads, or temporary files.
- Do not broaden the refactor into stream proxy handlers, authentication, imports, or migrations. The approved synchronization change is limited to extracting provider catalog retrieval and normalization from `performSync`.

---

### Task 1: Add failing EPG scheduler regression tests

**Files:**
- Create: tests/scheduler/epg_scheduler.test.js

**Interfaces:**
- Consumes: startEpgScheduler() from src/services/schedulerService.js.
- Produces: tests for one interval, per-ID overlap suppression, and cleanup after success/failure.

- [ ] **Step 1: Create the isolated test harness**

Create tests/scheduler/epg_scheduler.test.js with this mock setup:

~~~js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, mockEpg, state } = vi.hoisted(() => ({
  mockDb: { prepare: vi.fn() },
  mockEpg: { updateEpgSource: vi.fn(), updateProviderEpg: vi.fn() },
  state: { sources: [], providers: [] },
}));

vi.mock('../../src/database/db.js', () => ({ default: mockDb }));
vi.mock('../../src/services/syncService.js', () => ({ performSync: vi.fn() }));
vi.mock('../../src/services/epgService.js', () => ({
  ...mockEpg,
  pruneOldEpgData: vi.fn(),
}));
vi.mock('../../src/services/geoIpUpdateService.js', () => ({
  updateGeoIpDatabaseIfNeeded: vi.fn(),
}));
vi.mock('../../src/utils/helpers.js', () => ({
  isSafeUrl: vi.fn().mockResolvedValue(true),
}));

import { startEpgScheduler } from '../../src/services/schedulerService.js';

describe('EPG Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.sources = [];
    state.providers = [];
    mockDb.prepare.mockImplementation((sql) => ({
      all: vi.fn(() => sql.includes('epg_sources') ? state.sources : state.providers),
      get: vi.fn(),
      run: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
~~~

- [ ] **Step 2: Add interval de-duplication coverage**

Add a test with one due source, call startEpgScheduler() twice, advance fake timers by 60 seconds, and expect mockEpg.updateEpgSource to be called once. Run:

~~~bash
npm exec vitest run tests/scheduler/epg_scheduler.test.js
~~~

Expected before implementation: failure because the current function creates two intervals.

- [ ] **Step 3: Add overlap and successful-release coverage**

Add a test with source ID 7 and a pending first updateEpgSource promise. After the first 60-second tick expect one call; after a second tick while pending still expect one; resolve the promise, advance one millisecond and another 60-second tick, then expect two calls. Expected before implementation: failure because the second tick starts the pending update.

- [ ] **Step 4: Add failure-release coverage and close the suite**

Add a test with source ID 8 where the first update rejects and the second resolves. Advance one tick, flush one millisecond, advance another tick, and expect two calls. Close the describe block. Expected before implementation: failure if the in-flight marker is not released after rejection.

### Task 2: Prevent overlapping EPG scheduler work

**Files:**
- Modify: src/services/schedulerService.js:7-92
- Test: tests/scheduler/epg_scheduler.test.js

**Interfaces:**
- Consumes: existing EPG database queries, updateEpgSource, updateProviderEpg, isSafeUrl, and provider backoff.
- Produces: unchanged startEpgScheduler() API with one owned interval and per-ID in-flight exclusion.

- [ ] **Step 1: Add scheduler state**

Immediately after let syncInterval = null, add:

~~~js
let epgInterval = null;
const runningEpgUpdates = new Set();
~~~

- [ ] **Step 2: Own and replace the EPG interval**

At the beginning of startEpgScheduler(), add if (epgInterval) clearInterval(epgInterval). Assign the timer to epgInterval instead of discarding the return value.

- [ ] **Step 3: Guard custom sources**

Inside the due custom-source branch, use this structure around the existing update and log:

~~~js
const key = 'custom:' + source.id;
if (runningEpgUpdates.has(key)) continue;
runningEpgUpdates.add(key);
try {
  await updateEpgSource(source.id);
} catch (e) {
  console.error('Scheduled EPG update failed for ' + source.name + ':', e.message);
} finally {
  runningEpgUpdates.delete(key);
}
~~~

Keep the existing outer custom-source database-error handler.

- [ ] **Step 4: Guard providers**

Inside the due provider branch, add provider:<id> handling around URL validation and updateProviderEpg. Keep the unsafe-URL continue inside the try so finally executes:

~~~js
const key = 'provider:' + provider.id;
if (runningEpgUpdates.has(key)) continue;
runningEpgUpdates.add(key);
try {
  console.debug('Starting scheduled EPG update for provider ' + provider.name);
  if (provider.epg_url && provider.epg_url.trim() !== '') {
    if (!(await isSafeUrl(provider.epg_url))) {
      console.error('Unsafe EPG URL for provider ' + provider.name);
      failedUpdates.set(provider.id, now);
      continue;
    }
  }
  await updateProviderEpg(provider.id);
  failedUpdates.delete(provider.id);
} catch (e) {
  console.error('Scheduled EPG update failed for ' + provider.name + ':', e.message);
  failedUpdates.set(provider.id, now);
} finally {
  runningEpgUpdates.delete(key);
}
~~~

- [ ] **Step 5: Run focused scheduler tests**

~~~bash
npm exec vitest run tests/scheduler/epg_scheduler.test.js tests/scheduler/sync_scheduler.test.js
~~~

Expected: all scheduler tests pass.

### Task 3: Add the Redis index race regression test

**Files:**
- Modify: tests/managers/stream_manager_smart.test.js

**Interfaces:**
- Consumes: existing mockRedis, streamManager.init(null, mockRedis), and remove(id).
- Produces: coverage that an old stream cannot delete a newer user/IP index.

- [ ] **Step 1: Add the failing test**

Add to the Redis test block:

~~~js
it('does not delete a newer Redis user index when removing an old stream', async () => {
  mockRedis.hGet.mockResolvedValue(JSON.stringify({
    user_id: 1,
    ip: '1.1.1.1',
  }));
  mockRedis.get.mockResolvedValue('new-stream');

  await streamManager.remove('old-stream');

  expect(mockRedis.hDel).toHaveBeenCalledWith('iptv:streams', 'old-stream');
  expect(mockRedis.del).not.toHaveBeenCalled();
});
~~~

- [ ] **Step 2: Run and verify the expected failure**

~~~bash
npm exec vitest run tests/managers/stream_manager_smart.test.js
~~~

Expected before implementation: failure because the current code unconditionally calls del for the derived user/IP key.

### Task 4: Make Redis secondary-index cleanup conditional

**Files:**
- Modify: src/services/streamManager.js:124-156
- Test: tests/managers/stream_manager_smart.test.js

**Interfaces:**
- Consumes: existing Redis stream payload and index.
- Produces: unchanged remove(id) semantics except for safe index deletion.

- [ ] **Step 1: Compare the current index value**

Replace the unconditional Redis index deletion with:

~~~js
const indexKey = REDIS_PREFIX_USER + data.user_id + ':' + data.ip;
if (await this.redis.get(indexKey) === id) {
  await this.redis.del(indexKey);
}
await this.redis.hDel(REDIS_KEY_STREAMS, id);
~~~

Keep local resource cleanup, hGet, JSON parsing, error handling, key names, and hash deletion unchanged. Do not introduce a Redis script or transaction.

- [ ] **Step 2: Run stream-manager tests**

~~~bash
npm exec vitest run tests/managers/stream_manager_smart.test.js tests/stream_manager.test.js
~~~

Expected: all Redis and SQLite stream-manager tests pass.

### Task 5: Synchronize runtime and maintainer documentation

**Files:**
- Modify: README.md
- Modify: .env.example
- Modify: docs/CONFIGURATION.md
- Modify: docs/DEVELOPMENT.md
- Modify: docs/API_REFERENCE.md
- Modify: docs/PERFORMANCE_ANALYSIS.md

**Interfaces:**
- Consumes: package scripts, environment reads, route modules, Docker files, and CI workflow.
- Produces: verified setup, configuration, API, development, and performance documentation.

- [ ] **Step 1: Add supported environment variables to .env.example**

Keep existing values and add:

~~~dotenv
# Runtime Configuration
# NODE_ENV=production
# DATA_DIR=/data
# TRUST_PROXY=true

# Optional shared stream tracking across workers/instances
# REDIS_URL=redis://localhost:6379

# Stream session cleanup
STREAM_MAX_AGE_MS=86400000
STREAM_INACTIVITY_TIMEOUT_MS=120000

# Optional MaxMind GeoLite2 update key
# MAXMIND_LICENSE_KEY=
~~~

Do not add IS_SCHEDULER, which is an internal server flag.

- [ ] **Step 2: Update README setup and checks**

Change the Docker command to docker compose up -d. Document that DATA_DIR owns mutable databases, secrets, uploads, and cache, with Docker using /data. Add npm run build and npm run test:playwright:smoke to Development checks. State that REDIS_URL shares active-stream tracking across workers/instances and SQLite is the fallback.

- [ ] **Step 3: Update configuration and development docs**

In docs/CONFIGURATION.md, replace “in-memory tracking” with SQLite current_streams tracking in the Redis fallback description. In docs/DEVELOPMENT.md, list npm run test:playwright:smoke and state that it needs a running app/browser environment and is not part of default CI validation.

- [ ] **Step 4: Reconcile API details**

Keep the route inventory. Add this verified note near client logs:

~~~markdown
POST /api/client-logs is intentionally unauthenticated and rate-limited for
client error reporting; reading or deleting logs requires a JWT.
~~~

Change the proxy image entry to:

~~~markdown
- GET /api/proxy/image?url=<url>&provider_id=<id>
~~~

Do not add test-only routes or unverified schemas.

- [ ] **Step 5: Rewrite the performance analysis**

Replace the old “Proposed Optimization (Redis)” proposal with the implemented facts: SQLite uses prepared statements and WAL-backed current_streams; Redis is selected by REDIS_URL and stores iptv:streams plus one user/IP index per pair; Redis count, active-session, and same-session cleanup currently scan the stream hash and are O(n); Redis is suited to shared state across workers/instances while SQLite is the simple fallback; maintainers should benchmark real active-stream counts before adding secondary indexes or Lua transactions. Remove unsupported fixed concurrency and throughput claims.

- [ ] **Step 6: Check documentation for stale wording**

~~~bash
rtk grep -R -n -E 'Proposed Optimization|in-memory tracking|docker-compose up -d|REDIS_URL|test:playwright:smoke' README.md .env.example docs
~~~

Expected: no stale proposal/fallback wording remains and each new variable/command appears in the intended references.

### Task 6: Isolate provider catalog retrieval from synchronization persistence

**Files:**
- Modify: src/services/syncService.js
- Test: existing synchronization regression and performance suites

**Interfaces:**
- Consumes: the existing Xtream client, safe fetch path, M3U parser, and provider credentials.
- Produces: a private `fetchProviderCatalog()` helper returning the same normalized channels, categories, completeness, and snapshot state consumed by `performSync()`.

- [x] **Step 1: Characterize current synchronization behavior**

Run the synchronization regression, category-update, performance, and scheduler
tests before editing.

- [x] **Step 2: Extract catalog retrieval without changing persistence logic**

Move live/M3U fallback, VOD, and series retrieval/normalization into the helper;
leave the transaction, mappings, stale-channel cleanup, cache invalidation, and
sync logging in `performSync()`.

- [x] **Step 3: Re-run synchronization coverage**

Run the same focused synchronization suites after the extraction.

### Task 7: Isolate import decoding and provider validation

**Files:**
- Modify: src/controllers/systemController.js
- Test: tests/export_regression.test.js

**Interfaces:**
- Consumes: the existing encrypted export format, decompression limits, URL safety checks, and timezone validation.
- Produces: private helpers for archive decoding and provider validation; import responses and transaction behavior remain unchanged.

- [x] **Step 1: Characterize import/export behavior**

Run `tests/export_regression.test.js` before editing.

- [x] **Step 2: Extract input preparation**

Move encrypted archive decoding and provider URL/timezone validation out of the
HTTP controller while preserving the existing 400 responses and cleanup path.

- [x] **Step 3: Re-run import coverage and lint**

Run the export regression suite and ESLint after the extraction.

### Task 8: Remove redundant export array copying

**Files:**
- Modify: src/controllers/systemController.js
- Test: tests/system/export_data.test.js

**Interfaces:**
- Consumes: the same export queries and decrypted provider credentials.
- Produces: the same encrypted export format while assigning query results directly instead of copying unchanged rows one by one.

- [x] **Step 1: Characterize export behavior**

Run `tests/system/export_data.test.js` before editing.

- [x] **Step 2: Preserve only required transformations**

Assign unchanged query result arrays directly and keep the user-assignment
mapping as the only required row transformation.

- [x] **Step 3: Re-run export coverage and lint**

Run the export suite, ESLint, and whitespace checks after the change.

### Task 9: Cache repeated statistics channel lookups

**Files:**
- Modify: src/controllers/systemController.js
- Test: the isolated full suite

**Interfaces:**
- Consumes: the existing active-stream list and prepared channel lookup.
- Produces: the same statistics payload while avoiding duplicate SQLite reads for identical provider/channel pairs during one request.

- [x] **Step 1: Identify the request-local N+1 read**

Confirm the active-stream mapping performs one prepared query per stream even
when multiple streams reference the same channel.

- [x] **Step 2: Add a request-local cache**

Cache both found and missing channel rows without changing the SQL or response
shape.

- [x] **Step 3: Run the complete isolated suite**

Run lint, the full isolated test suite, build, and whitespace checks after the
change.

### Task 10: Reuse EPG import batch buffers

**Files:**
- Modify: src/services/epgService.js
- Test: tests/epg_streaming.test.js, tests/services/epg_service.test.js

**Interfaces:**
- Consumes: the existing streaming XML parser and synchronous SQLite batch transaction.
- Produces: the same channel/program inserts while clearing batch arrays in place instead of allocating replacements after every flush.

- [x] **Step 1: Characterize EPG streaming behavior**

Run the streaming and service EPG tests before editing.

- [x] **Step 2: Reuse completed batch buffers**

Clear the arrays after the synchronous transaction without changing batch size,
insert order, parser events, or error handling.

- [x] **Step 3: Re-run EPG coverage and the isolated suite**

Run the focused EPG tests, ESLint, the full isolated suite, and build checks.

### Task 11: Cache repeated Xtream episode lookups

**Files:**
- Modify: src/controllers/xtreamController.js
- Test: tests/controllers/xtream_channels_json.test.js

**Interfaces:**
- Consumes: the existing series-episode query and per-user-channel alias generation.
- Produces: the same player JSON while reusing immutable episode rows for repeated provider/series pairs during one request.

- [x] **Step 1: Characterize player JSON behavior**

Run `tests/controllers/xtream_channels_json.test.js` before editing.

- [x] **Step 2: Cache only episode query results**

Cache found and empty episode arrays by provider source and remote series ID;
keep alias generation keyed by the user channel.

- [x] **Step 3: Re-run Xtream coverage and the isolated suite**

Run the focused Xtream test, ESLint, the full isolated suite, and diff checks.

### Task 12: Cache repeated M3U episode lookups

**Files:**
- Modify: src/controllers/xtreamController.js
- Test: tests/controllers/xtream_get_playlist.test.js, tests/controllers/xtream_share_compat.test.js

**Interfaces:**
- Consumes: the existing M3U series-episode query and per-user-channel alias generation.
- Produces: the same playlist stream while reusing immutable episode rows for repeated provider/series pairs during one request.

- [x] **Step 1: Characterize playlist behavior**

Run the playlist and share-compatibility tests before editing.

- [x] **Step 2: Cache only episode query results**

Cache found and empty episode arrays by provider source and remote series ID;
keep alias generation and URL construction per user channel.

- [x] **Step 3: Re-run playlist coverage and the isolated suite**

Run the focused playlist tests, ESLint, the full isolated suite, and diff checks.

### Task 13: Verify the complete focused change

**Files:**
- Test: all files changed in Tasks 1–12

**Interfaces:**
- Consumes: modified scheduler, stream manager, tests, and documentation.
- Produces: clean scoped diff with passing checks and no runtime artifacts.

- [x] **Step 1: Run lint**

~~~bash
npm run lint
~~~

Expected: exit code 0.

- [x] **Step 2: Run targeted tests**

~~~bash
npm exec vitest run tests/scheduler/epg_scheduler.test.js tests/scheduler/sync_scheduler.test.js tests/managers/stream_manager_smart.test.js tests/stream_manager.test.js tests/docs_smoke.test.js
~~~

Expected: all targeted files pass.

- [x] **Step 3: Run the full isolated suite**

~~~bash
DATA_DIR="$(mktemp -d)" npm test
~~~

Expected: the full suite passes without repository runtime data.

- [x] **Step 4: Run the build**

~~~bash
npm run build
~~~

Expected: the no-op build check exits with code 0.

- [x] **Step 5: Inspect scope and artifacts**

~~~bash
git diff --check
git diff --stat
git status --short
~~~

Expected: only approved source, test, docs, spec, and plan files are changed; no db.sqlite*, epg.db*, secret.key, jwt.secret, cache/, temp_*, or upload data is staged.

- [x] **Step 6: Commit implementation**

~~~bash
git add src/services/schedulerService.js src/services/streamManager.js tests/scheduler/epg_scheduler.test.js tests/managers/stream_manager_smart.test.js tests/docs_smoke.test.js README.md .env.example docs/CONFIGURATION.md docs/DEVELOPMENT.md docs/API_REFERENCE.md docs/PERFORMANCE_ANALYSIS.md docs/superpowers/plans/2026-08-01-code-audit-documentation-refresh.md
git commit -m "fix: prevent overlapping epg and redis stream cleanup"
~~~
