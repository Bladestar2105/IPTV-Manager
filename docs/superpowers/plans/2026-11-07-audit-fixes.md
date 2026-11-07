# Xtream compatibility and production audit fixes — implementation plan

> For agentic workers: use superpowers:subagent-driven-development or executing-plans. Work in the existing checkout; do not create worktrees.

**Goal:** Fix issue #644 and all 25 verified audit findings, obtain an independent Ponytail review, and deliver one tested pull request.

**Architecture:** Keep the existing Express controllers, SQLite schema, proxy grants and frontend. Correct shared authorization, reservation, import and formatting boundaries; reuse existing helpers and add focused regression tests. No new dependencies or unrelated refactors.

**Tech stack:** Node.js >=24, Express, better-sqlite3, optional Redis, browser JavaScript, Vitest.

**Spec:** The requirements table below records the user's 2026-11-07 instruction and verified whole-repository audit. Issue #644: https://github.com/Bladestar2105/IPTV-Manager/issues/644.

## Global constraints

- Preserve runtime data, existing identifiers, client resource privacy and valid administrator grants.
- Preserve normal-user list editing independently of provider management access.
- Never use repository runtime databases for tests; use isolated DATA_DIR or in-memory SQLite.
- All shell tool invocations use RTK; tests themselves use ordinary Node/npm commands.
- Workers own disjoint files, never revert others, and leave commits to the coordinator.
- Update relevant API/configuration/development documentation; disclose signing-key rotation.
- Close #640 first; keep the #644 reply about EPG only. Document other fixes in the PR.

## Requirements and completion ledger

| ID | Verified failure / required result | Owner | State |
| --- | --- | --- | --- |
| EPG | Numeric now_playing/has_archive in all Xtream EPG listings; exact time boundaries | root | implemented; 12 tests passed before audit |
| 01 | Public JWT placeholder must never sign tokens; safe persistent rotation | UI/setup | implemented; independently reviewed and verified |
| 02 | Expired accounts rejected, including cached/token paths; correct expiry output | root | implemented; reviewed and regression-tested |
| 03 | Share deletion/restriction checked immediately across workers | root | implemented; reviewed and regression-tested |
| 04 | VOD metadata/playback require movie assignments | root + streaming | implemented; independently reviewed and verified |
| 05 | User/provider capacity check plus registration atomic in SQLite/Redis | streaming | implemented; independently reviewed and verified |
| 06 | FFmpeg final-URL headers preserve cookies and strip cross-origin credentials | streaming | implemented; independently reviewed and verified |
| 07 | Foreign-worker cleanup stops owner resource before releasing accounting | streaming | implemented; independently reviewed and verified |
| 08 | Raw catch-up streams receive activity heartbeats | streaming | implemented; independently reviewed and verified |
| 09 | Incomplete XMLTV cannot replace valid EPG | data | implemented; 176 focused tests passed |
| 10 | OTP export/import portable between installation encryption keys | data | implemented; 176 focused tests passed |
| 11 | Backup restore retains currently valid administrator grants | data | implemented; 176 focused tests passed |
| 12 | Backup restore preserves existing episode aliases for unchanged assignments | data | implemented; 176 focused tests passed |
| 13 | Delayed automatic EPG matching cannot overwrite newer manual mappings | data | implemented; 176 focused tests passed |
| 14 | All catalog downloads use bounded safe transport | data | implemented; 176 focused tests passed |
| 15 | Installer protects .env and preserves executable/file permissions | UI/setup | implemented; independently reviewed and verified |
| 16 | Logout/login clears privileged DOM and rejects late session responses | UI/setup | implemented; independently reviewed and verified |
| 17 | Share names and embedded attributes escaped | UI/setup | implemented; independently reviewed and verified |
| 18 | Minimal-system updater does not require undeclared sudo or leave service stopped | UI/setup | implemented; independently reviewed and verified |
| 19 | AI idempotency keys work over documented LAN HTTP | UI/setup | implemented; independently reviewed and verified |
| 20 | get_profile/get_server_info aliases work with installed Xtream client | root | implemented; reviewed and regression-tested |
| 21 | Series last_modified uses stable stored upstream value | root | implemented; reviewed and regression-tested |
| 22 | VOD detail container extensions normalized consistently | root | implemented; reviewed and regression-tested |
| 23 | VOD/series detail category IDs refer to Manager categories | root | implemented; reviewed and regression-tested |
| 24 | Server metadata reflects external origin and a consistent timezone | root | implemented; reviewed and regression-tested |
| 25 | Browser catalogs have continuation beyond 150/200 items | UI/setup | implemented; independently reviewed and verified |

## Review focus

- Concurrent starts, cancellations and repeated cleanup must not leak resources or exceed limits.
- Revoked/expired access must fail for raw streams as well as nested proxy resources.
- Backup/import rollback must preserve IDs, current grants, OTP and cached episode URLs.
- Mid-download XML/HTTP failures must preserve the last valid data snapshot.
- Same-tab account changes and ordinary LAN HTTP must remain usable without leaking prior-session data.

## Task 1 — streaming and resource accounting

Files: streamControllerHelpers.js, streamController.js, streamMediaController.js, streamManager.js, clientResourceService.js, server.js and focused streaming tests.

Interfaces: consume current authenticated users and grants; preserve reserveChannelSession/reserveProviderSession contracts or coordinate any signature change before callers change. Root owns getXtreamUser and playerApi.

- [x] Write failing regressions for wrong type, concurrent user/provider reservations, cross-worker cleanup, catch-up heartbeats and final-URL FFmpeg context.
- [x] Verify each regression fails for the audited reason.
- [x] Implement the smallest shared fixes, including every reservation caller and SQLite/Redis behavior.
- [x] Run targeted tests and self-review connected paths; report exact commands and risks.

## Task 2 — data integrity and safe synchronization

Files: backupController.js, systemDataController.js, epgImportService.js, epgMappingController.js, providerCatalogSyncService.js and focused data/import/sync tests.

Interfaces: preserve response shapes and existing schema; coordinate crypto helper changes with UI/setup owner. Keep historical/crafted grant rejection.

- [x] Add regressions for incomplete XML, OTP across different keys, valid current grants, stable aliases, delayed mapping and stalled/oversized catalog bodies.
- [x] Observe intended failures before changing production code.
- [x] Fix each trust/transaction boundary without whole-table migrations.
- [x] Run focused tests and report implementation details for documentation/review.

## Task 3 — browser and installation fixes

Files: public/app.js, public/ai.js, public/player.js, scripts/install.sh, scripts/update.sh, .env.example, src/utils/crypto.js and related tests.

Interfaces: preserve existing DOM/API contracts; use crypto.getRandomValues for browser keys. Root owns documentation.

- [x] Add failing tests for known signing placeholder, protected configuration, minimal update, session DOM cleanup, escaping, HTTP AI keys and catalog continuation.
- [x] Verify the intended failures.
- [x] Implement minimal fixes; retain old installation data and runtime secrets.
- [x] Run focused tests and report external behavior/security migration notes.

## Task 4 — authentication and Xtream contracts

Files: authService.js, shareController.js as needed, xtreamPlayerApiController.js, shared utilities if necessary and focused auth/Xtream tests.

- [x] Test expiry representations and cached access, updated/deleted shares, all aliases, metadata IDs/extensions/timestamps/origin.
- [x] Verify failures, then reuse expiryEpoch/getBaseUrl/normalizeContainerExtension and shared authorization.
- [x] Run focused tests, update API/configuration/development documentation and reconcile all 25 ledger rows.

## Integration and delivery

- [x] Close #640 as completed after checking the reporter's confirmation.
- [x] Run lint, targeted tests, full npm test, build, dependency audit and appropriate browser smoke checks.
- [x] Independent Ponytail whole-repository/connected-code review; verify and fix findings, then re-review changed paths.

Publication follows this committed ledger: push `codex/fix-xtream-epg-flags` and
create one PR against main documenting every fix, validation and runtime limit.
The PR links/closes #644 on merge. Reply to #644 with only the EPG correction
and PR/testing status; do not imply release or deployment. GitHub is the source
of truth for publication status.

## Decisions / evidence

- Baseline at main 5f67718: final repeat 176 files, 2206 tests passed, one skipped; lint/build/npm audit passed. Earlier ai_api runs were intermittent; preserve exact failures if they recur.
- Existing uncommitted files at start: EPG formatter, EPG batch tests and API reference; all belong to this task.
- User explicitly authorized all fixes, review, commits, push, PR and issue response; no additional execution approval is required.

- Root verification: 28 auth/Xtream contract tests passed. Added real-SQLite tests
  reproduced cached expiry/revocation/share changes and nine Xtream contract
  failures before the fixes. WebUI and AI use the same expiry normalization.
- Data worker final verification: 16 suites / 176 tests passed; lint and diff
  whitespace checks passed. Legacy enabled OTP is never silently disabled.
- Real Redis 7.2.4 was built only under `/tmp` for isolated integration checks;
  no production Redis or external provider is used by these regressions.

## Independent review follow-up

| ID | Confirmed remaining defect | Resolution |
| --- | --- | --- |
| R01 | Malformed encoded M3U header throws outside import promise and crashes process | Parser rejects and destroys source; child-process regression passed |
| R02 | Invalid live JSON object breaks valid M3U fallback and falsely marks empty success | Array replacement and completion after conversion; regression passed |
| R03 | Hidden current admin grants lost on restore | Read active grant independently of user visibility; both restore states passed |
| R04 | M3U fallback lacked byte budget | Counting transform/pipeline rejects oversized lines and destroys source; regression passed |
| R05 | Failed live npm ci removes dependencies before service recovery | Staged exact commit; seven real Git-fixture scenarios passed |
| R06 | Actual user selects/share banner retain old administrator data | Actual DOM targets cleared; focused tests passed |
| R07 | EPG logo attributes/provider owner name inject management HTML | All known HTML sinks escaped; regressions passed |
| R08 | Documented wildcard CORS and spaced allowlist fail | Normalized origin options; four behavior tests passed |
| R09 | Concurrent Redis same-session reservations cancel each other | Atomic election selects one survivor; real Redis race passed |
| R10 | Crashed remote owner needs a safe recovery path | Explicit identity-checked recovery only after confirmed instance shutdown; real Redis checks passed |
| R11 | Redis touch resurrects deleted rows | Atomic update-if-present; real Redis regression passed |
| R12 | Deleting user leaves raw playback alive | Account fence before teardown plus synchronous start fence; failure restores state; regression passed |
| R13 | Legacy MPD wildcard can send provider credentials to attacker origin | Only original manifest alias accepted; nested dependencies use grants; privacy regressions passed |

- Extended Playwright smoke passed, including held admin settings response across
  same-tab logout/normal login and private Security DOM clearing.
- Initial full integration run: 2294 tests passed, 13 failed, one skipped.
  Two failures were deliberate new hidden-grant regressions being fixed while
  the run was active. XMLTV attributed root parsing was a real regression and
  now passes its 31 focused tests. The remaining streaming test harnesses were
  updated to initialize the real manager before exercising reservations.
- Lint/build and dependency audit passed; npm audit reports zero vulnerabilities.

| ID | Confirmed remaining defect | Resolution |
| --- | --- | --- |
| R14 | Signature-only schedule JWT bypasses current expiry/revocation | Existing auth middleware reused; real account-state tests passed |
| R15 | Cached shared catalog outlives share scope/window | Guest caching bypassed; scope and expiry regressions passed |
| R16 | Request-controlled catalog keys retain unlimited full catalogs | 16 MiB + 32 entry + 60s bounds; regression passed |
| R17 | Share admin edits invalidate admin instead of owner; rename/delete misses invalidation | Actual owner/list edits invalidate; focused tests passed |
| R18 | Track/subtitle work bypasses user/provider reservations | Probe/subtitle reservations release on completion/close; closed 206 cannot start FFmpeg; regressions passed |
| R19 | Failed provider details/categories leave response bodies open | Discard failed bodies; stream-destruction regressions passed |
| R20 | Uncached tab retains old interactive catalog rows | Clear immediately, show loading state and guard controls; independent UI tests passed |
| R21 | Credential-auth catalog produces token-only playback URLs | Encoded credential paths plus isolated auth cache modes; independent real-auth contract passed |
| R22 | Credential/query suffixes confuse browser playback format; username mpd collides with route prefix | Actual pathname suffix shared across Player/Cast; prefix shortcut removed; 28 new format cases passed; independent Ship |

### Review coverage and safety decision

Three independent Ponytail reviewers statically read the complete first-party
backend (all controllers, services, database/migrations, utilities, routes,
middleware and server), frontend and deployment paths, including unchanged
modules. Imported vendor code and binary artwork are not application-source
review targets. The UI/deployment reviewer completed the extra HTML/CSS/translations/smoke/
profile coverage, including all seccomp rules and translation structure.

Missing Redis acknowledgement is not proof that a paused or partitioned owner
is dead. Rejected automatic lease reaping/watchdogs in favor of explicit,
identity-checked admin orphan recovery after the operator stops the instance.
Normal removal retains capacity until termination is acknowledged.

- UI/deployment independent final rereview: 33 tests passed in four suites;
  all four findings corrected. Complete HTML/CSS, smoke helpers and security
  profiles read; translation structure checked across 717 keys/four languages.
- Data/auth independent final rereview: 61 tests passed in four suites;
  all four remaining findings corrected; all initially noted source gaps read.
- Streaming/protocol reviewer read all 58 assigned production files and verified
  the root-owned EPG/share/cache/invalidation fixes. Final independent rerun:
  seven suites / 120 tests passed, including isolated real Redis recovery and
  SQLite delete/start race checks. Verdict: Ship, subject to final integration.
- Final extended browser smoke passed using an isolated temporary DATA_DIR.

- Final synthetic AI browser smoke passed (106.6 seconds): all eight functions,
  four languages, delayed history/undo isolation, account linking/cancellation,
  quota/disconnect and blocked verification URLs. No live model requests.

## Additional user request — web-player catalog loading

The user added slow category/default-all loading to the same delivery. Measure
startup catalog construction, EPG transfer and browser rendering independently.
Fix the measured root cause while preserving full catalog availability, current
share/ownership checks, opaque resources and accessible continuation. Keep
companion API defaults backward-compatible; add focused contract/browser
regressions and record before/after synthetic measurements before final review.

- Profiled the real isolated controller with 5,000 live channels + 150 series ×
  100 episodes. Cold expanded response: 4,502 ms / 10.93 MB / 15,000 alias writes.
  Actual new typed Live request: 145 ms / 2.71 MB / zero aliases; series folders:
  5 ms / 72.5 kB / zero aliases. No providers contacted.
- Added optional type filtering + series summaries while preserving expanded
  companion defaults. Five new failing contract cases observed, then fixed;
  contract/privacy/protocol regressions passed. Frontend lazy tabs, local series
  IDs, retry/generation guards and formatter reuse were independently reviewed.
- Final performance review found two additional cases: uncached tabs kept old
  interactive rows during loading, and credential-auth catalogs used token-only
  playback paths. The UI now clears rows immediately and disables filters while
  loading; URLs encode real credentials and isolate authentication cache modes.
  Red/green regressions include actual getXtreamUser playback authentication,
  DASH/series URLs and reserved path characters. Four suites / 54 tests passed.
  The connected format check now uses only the pathname suffix across playback,
  Cast and transcode/catch-up helpers. The redundant MPD-route prefix shortcut
  was removed after a legal username `mpd` reproduced a TS/DASH collision.
  Twenty-eight new format cases passed after observing the intended failures.
  Ten browser-unit files / 92 tests passed; final independent rereview passed
  three suites / 58 tests with no remaining findings.
- Real-browser synthetic API smoke passed: Live-only startup, search reaches
  the 501st channel, continuation 200→400 live / 150→300 movies, correct local
  series detail ID and cached tabs; no page errors. No provider was contacted.

- Final integration repeated with isolated DATA_DIR and real Redis: one AI job
  test returned unexpected 403 before job creation; the preceding full run was
  green. Isolated and controlled concurrent/shuffled runs did not establish a
  production cause; one separate cancellation assertion failed once. Those two
  assertions now retain HTTP bodies on failure. Temporary diagnostics were
  removed; no speculative runtime fix or retry was added.

## Final delivery verification

- `npm run lint` passed.
- Full `npm test` passed with isolated `DATA_DIR` and temporary Redis 7.2.4:
  **193 files, 2,416 passed, one expected platform-dependent skip**
  (`ai_codex_isolation`: sealed process-tree mask on this macOS runtime).
  All 14 real-Redis integration tests ran and passed.
- `npm run build` passed (this project has no compilation step).
- `npm audit --json`: zero vulnerabilities; no dependency changes.
- Installer/updater shell syntax and `git diff --check` passed.
- Extended `test:playwright:smoke` passed with isolated runtime data, including
  same-tab administrator logout/normal-user login with delayed responses.
- `test:playwright:ai` passed: all eight functions, four languages and session/
  history/undo/quota/link isolation, using synthetic model responses.
- Real-browser player smoke passed: Live-only startup, search beyond the first
  page, continuation, local series detail IDs and cached tabs; no page errors.
- Final connected player rereview: Ship, 58 independently rerun tests passed.
  All browser unit suites: 92 tests passed, including 28 new format cases.

Local runtime: Node.js 26.8.2. GitHub validation additionally runs Node.js 24
and the real Docker/native-runtime checks.

The final complete run passed the previously intermittent AI job tests. Their
earlier isolated failures remain unexplained; no speculative runtime change was
made. All three complete-source reviewers and the final player-path rereviewer
reported Ship after corrections. Real providers, DRM/Cast hardware, sustained
multi-host load and productive deployment were not exercised.
