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

## Web Player Performance

The browser player renders the channel list before EPG schedule data is loaded.
Keep `/api/epg/schedule` scoped to the authenticated user's visible EPG channel
IDs so large global EPG imports do not block player startup or send unrelated
programme data to the browser.
