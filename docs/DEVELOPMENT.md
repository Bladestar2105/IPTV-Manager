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
- GeoIP auto-update when a MaxMind license key is configured

## Database Migrations

Migrations run from `initDb(true)` in the primary process before workers start.
Keep migrations idempotent and guarded by schema checks or marker rows in
`settings`. Avoid unbounded work on every restart.

Heavy one-time migrations should:

- log clearly before expensive work starts
- mark completion in `settings`
- avoid repeated `VACUUM`
- preserve existing user/provider data
