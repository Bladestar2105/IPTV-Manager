# Development Notes

## Local Setup

- Primary package manager: `npm`.
- Install dependencies: `npm install`.
- Run app: `npm start`.
- Run checks:
  - `npm run lint`
  - `npm test`
  - `npm run build`

The Docker image and release workflow use `package-lock.json` and `npm ci`.
If dependencies change, keep `package.json` and `package-lock.json` in sync.

## Pull Request Validation

Pull requests to `main` must pass the Node.js 24 validation job before merge.
It installs from `package-lock.json` with `npm ci`, runs ESLint, executes the
full test suite with an isolated temporary `DATA_DIR`, runs the build command,
and fails on high or critical production dependency vulnerabilities. The
temporary test directory is removed even when a test fails. Pull-request Docker
builds run only after validation and verify the image without logging in to the
registry or publishing it. Tagged release archives depend on both validation
and the Docker job, so failed lint, tests, builds, or audits block publishing.

Node.js 24 or newer is the supported runtime. `better-sqlite3` is a native
dependency and `geoip-lite` requires Node.js 24+, so reinstall dependencies with
`npm install` after changing Node versions to keep native bindings aligned with
the active Node ABI. The Docker image and release workflow build against Node.js
24 with `npm ci`.

For bare-metal major Node upgrades, update `/opt/iptv-manager/scripts/update.sh`
from `main` before running it so the updater can install the required runtime
before `npm install`.

## Maintainer Documentation

- API route inventory: `docs/API_REFERENCE.md`.
- Runtime environment and Docker configuration: `docs/CONFIGURATION.md`.
- Share companion integration details: `docs/SHARE_COMPANION_INTEGRATION.md`.

Update these files when routes, environment variables, setup, Docker behavior,
or integration behavior changes.

## Browser Player Audio Fix

The Web Player can retry a stream with `transcode=true` when browser playback
hits unsupported TV audio codecs such as AC-3, E-AC-3, DTS, or MP2/MPEG Layer 2.
Manual audio fix remains a global user preference in `transcode_enabled`.
Automatic codec fallback is scoped per stream in `player_auto_transcode_streams`
so one incompatible channel does not force all later streams through FFmpeg.

For VOD movie and series playback the Web Player can request server-side track
metadata with `tracks=true`. Selecting a server-side subtitle track adds an
external WebVTT `<track>` via `subtitle_track=<ffmpeg_stream_index>` and
`subtitle_format=vtt`, so the video URL remains seekable. Selecting a
server-side audio track still uses the FFmpeg MP4 output path with
`audio_track=<ffmpeg_stream_index>`.

For an explicit cross-owner channel grant, stream reservation always evaluates
the exact source provider first and applies that provider's connection limit and
backup URLs. A target-user provider account is eligible as account-level
failover only when its normalized primary URL appears in the exact source
provider's configured backup URL list. Merely sharing the same panel URL does
not make another account compatible. Movie URL suffixes remain accepted for
client compatibility, but the upstream extension comes only from stored channel
metadata and falls back to `mp4`.

## Local Data

By default the app stores runtime data in the repo root unless `DATA_DIR` is set.
Common generated files:

- `db.sqlite*`
- `epg.db*`
- `secret.key`
- `jwt.secret`
- `cache/`
- `temp_*`

These are ignored by Git. Do not commit runtime databases, secrets, cache data,
or test-generated temp directories.

For local tests that should not touch the repo root, run with a temp data dir:

```bash
DATA_DIR="$(mktemp -d)" npm test
```

The npm test scripts disable Vitest file parallelism because several integration
tests import the Express app and real SQLite databases from the same `DATA_DIR`.
Keep this behavior unless those tests are changed to create isolated databases
per test file.

## Docker Startup

Docker runs as the non-root `app` user. The entrypoint may fix `/data`
ownership for old root-owned volumes, but it should not recursively chown
`/app` on every start because `/app` contains `node_modules` and can make
container startup slow.

If startup is slow, check logs for:

- repeated ownership fixes on a large `/data` volume
- one-time database migration logs such as `Running VACUUM`
- GeoIP auto-update when a MaxMind license key is configured. The scheduler
  fetches MaxMind checksum files first and only starts the expensive
  `geoip-lite` update process when country or city data changed, or when local
  GeoIP data files are missing. Docker persists updated GeoIP files in
  `/data/geoip` by symlinking `geoip-lite/data` there before Node starts.

## Database Migrations

Migrations run from `initDb(true)` in the primary process before workers start.
Keep migrations idempotent and guarded by schema checks or marker rows in
`settings`. Avoid unbounded work on every restart.

Heavy one-time migrations should:

- log clearly before expensive work starts
- mark completion in `settings`
- avoid repeated `VACUUM`
- preserve existing user/provider data

The channel-authorization migration preserves assignment IDs and the existing
`is_hidden` value, adds `authorization_revoked`, and marks ungranted ownership
mismatches as revoked. Databases that ran the earlier pre-release grant
migration keep any rows that migration hid; an approved sync can clear only
their authorization revocation, while an administrator must explicitly restore
a selected channel to clear its hidden state. Re-running the migration is
idempotent and does not infer administrator grants.

Automatic category synchronization records ownership of new assignments with
`assignment_origin = 'mapping'` and the active `mapping_id`. Explicit channel
adds and re-adds use `assignment_origin = 'manual'` and clear `mapping_id`.
Rows created before trustworthy provenance, or by an old import, use
`legacy`/`imported`; mapping lifecycle code never moves or deletes those rows.
The origin column has a SQLite CHECK constraint and an origin/mapping index.

`user_channel_mapping_backfill_v1` is now a marker-only compatibility migration;
it never infers ownership from matching provider/category fields. The versioned
`user_channel_assignment_provenance_v2` migration runs after the origin column
exists and before deduplication. It converts all uncertain pre-V2 rows to
`legacy` with `mapping_id = NULL`, preserving IDs, visibility, names, grants,
sort order, and series aliases. Its marker makes the repair idempotent.

`user_channel_deduplication_v1`, backup restore, full-system import, cloning,
category import, and mapping retargeting share one deterministic merge helper.
The helper merges by category/provider-channel identity, prefers
manual > legacy/imported > mapping, keeps hidden state, selects a deterministic
custom name and lowest valid sort order, recalculates authorization, and
rebinds/de-duplicates series aliases before removing losers. Modern backup and
system formats may retain mapping ownership only after relationship validation;
legacy formats are imported as unowned.

Provider sync state is persisted per provider and stream type in
`provider_sync_state`. A first complete empty snapshot with local rows is
recorded but is not destructive; cleanup requires a second consecutive empty
snapshot. Non-empty snapshots reset the counter, and failed or invalid fetches
leave it unchanged. Provider deletion removes the state through its foreign-key
cascade.

## Series Episode Cache Identity

Series episode metadata is keyed by the normalized upstream panel URL. Provider
accounts that use the same normalized URL therefore share one episode catalog.
This assumes that series IDs, episode IDs, metadata, and container extensions
are panel-global and do not vary by account. The first successful sync remains
authoritative while its `last_modified` state is current; a later eligible and
successful refresh for the same panel and series becomes the new authoritative
record. Failed or unchanged sibling-account syncs do not overwrite cached
metadata.

## Web Player Performance

The browser player renders the channel list before EPG schedule data is loaded.
Keep `/api/epg/schedule` scoped to the authenticated user's visible EPG channel
IDs so large global EPG imports do not block player startup or send unrelated
programme data to the browser.
