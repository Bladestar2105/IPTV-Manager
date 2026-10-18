# Binary PlayReady Privacy Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent binary parser and compact-grant tasks, then integrate and request fresh independent reviews.

**Goal:** Preserve PlayReady playback while replacing provider license URLs inside MP4 initialization and media-fragment PSSH records with authenticated Manager URLs.

**Architecture:** Issue compact persisted license grants with the existing fresh account/share/channel authorization. Rewrite PlayReady metadata without changing MP4 byte positions whenever a compact URL fits the existing WRMHEADER budget. Buffer only bounded metadata boxes, preserve media samples and non-PlayReady DRM records, and explicitly reject unsupported layouts rather than leaking or corrupting bytes. Range responses must use transformed metadata at their original positions; a range must never bypass inspection.

**Tech Stack:** Node.js streams, SQLite, existing PlayReady parser and grant authorization; no new dependencies.

**Spec:** User instruction in this task: preserve PlayReady and rewrite binary DRM metadata; provider resources/credentials remain behind Manager for all clients. YouTube remains direct and uncached.

## Global Constraints

- No push before local fixes, full checks and independent reviews are clean.
- Preserve production data, authentication, provider/user capacity and unrelated media bytes.
- Use isolated runtime data for tests; do not commit caches or secrets.
- Record any unsupported MP4 profile explicitly; do not claim arbitrary binary coverage.

## Review Focus

- PSSH in both moov initialization and moof/key rotation, including concatenated records and chunk boundaries.
- Original HTTP ranges, DASH/HLS byte ranges and partial metadata must not expose an unmodified URL.
- Version-1 KIDs, non-PlayReady PSSH, checksums and media offsets remain unchanged.
- Long Manager origins, malformed/truncated boxes and metadata size/time limits fail safely.
- Compact grants retain fresh revocation, encrypted headers/cookies, channel/share scope and redirect safety.

### Task 1: Compact license grants

**Files:** clientResourceService, database initialization/migrations, a short license route and focused tests. Coordinate app route mounting with parent.

**Interface:** `createClientResourceUrl(req, user, upstream, {kind:'license', compact:true, ...context})` returns a short absolute Manager URL; resolving it runs the existing fresh grant checks.

- [x] Add failing tests for persistence/restart, expiry/revocation, encrypted provider headers and bearer-token rejection.
- [x] Implement opaque random IDs and bounded expiry cleanup using an idempotent schema migration.
- [x] Reuse ordinary license relay behavior, including raw challenge bytes, SOAPAction and scoped redirects.
- [x] Verify targeted tests and lint. Parent commits after integration.

### Task 2: Bounded length-preserving MP4 metadata rewriting

**Files:** new `src/utils/clientMp4.js`, existing PlayReady utility only where needed, new focused binary fixtures/tests.

**Interface:** streaming transform/buffer helper accepts a license URL mapper and returns identical-length MP4 bytes with rewritten PlayReady PSSH; normal non-MP4/media payloads pass unchanged.

- [x] Add failing real-box fixtures for moov/moof, multiple systems, version-1 KIDs, split chunks, invalid sizes and insufficient URL budget.
- [x] Rebuild PRO XML with safe padding to preserve the original PSSH length; validate every supported container before emitting it.
- [x] Bound buffered metadata and reject unsupported unsafe PSSH before it reaches clients.
- [x] Assert exact file length, box offsets, sample bytes and decoded Manager license targets.

### Task 3: Relay and range integration

**Files:** proxy route, stream controller helpers/controllers, manifest range metadata if needed, regression tests and API/configuration docs.

- [x] Add end-to-end failures for initialization and media-fragment PSSH through initial routes and nested grants.
- [x] Apply the shared transform with compact license grants and existing scoped upstream context.
- [x] Ensure requested byte ranges are sliced from inspected/transformed metadata; preserve correct Content-Range/length and avoid unbounded media buffering.
- [x] Verify provider connection accounting, request abort and backpressure behavior.
- [x] Document supported behavior and precise fail-closed limits.
- [ ] Freeze local SHA; run full suite, lint/build/smoke and two fresh independent reviews before push/re-review.
