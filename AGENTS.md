# AGENTS.md

## Repository Purpose

IPTV-Manager is a Node.js/Express IPTV management server with:

- Web UI under `public/`
- REST/Xtream/HDHomeRun endpoints under `src/routes/` and `src/controllers/`
- SQLite persistence under `DATA_DIR`
- optional Redis stream tracking
- Docker and bare-metal deployment paths

Treat changes as production backend changes. Preserve user data, stream
reliability, authentication behavior, and Docker upgrade compatibility.

## Working Rules

- Prefer small, focused fixes.
- Read the relevant controller, route, service, and DB schema before editing.
- When changing routes, environment variables, setup, Docker behavior, or
  integration behavior, update `README.md`, `docs/API_REFERENCE.md`,
  `docs/CONFIGURATION.md`, or `docs/DEVELOPMENT.md` as relevant.
- Do not commit runtime data, databases, secrets, cache files, or temp upload
  data.
- Do not introduce new dependencies unless clearly justified.
- Keep API responses backward-compatible unless explicitly requested.
- Avoid broad refactors in controllers that handle streaming, auth, provider
  sync, EPG, imports/exports, or database migrations.
- `provider_access` is disabled for normal users by default and controls only
  upstream provider management and connection-details visibility. Provider
  names/options and catalog rows remain available for list editing; restricted
  catalog responses must omit raw stream URLs, HTTP headers, and DRM metadata.
  It must not remove a user's ability to edit their own channel, movie, series,
  or category-scoped EPG mappings.

## Client Resource Privacy

- Client-facing provider URLs, credentials and provider CDN resources must stay
  behind Manager proxy grants, including nested playback dependencies and DRM.
- Unknown external hosts are proxied by default. Public metadata/artwork links
  from approved YouTube, IMDb, TMDB and TVDB domains may remain direct; YouTube
  trailers must not be proxied or cached by Manager.
- Keep these exceptions centralized in `src/utils/clientResourcePolicy.js`.
  Never exempt arbitrary third-party/CDN hosts merely because their origin
  differs from the configured provider. Credential-bearing URLs and DRM license
  requests remain proxied even on approved public domains.
- Inspect binary MP4 PlayReady metadata as well as manifests. Preserve media
  sample bytes and offsets while replacing provider license addresses.
- Relay Matroska (MKV/MKA) media unchanged through Manager, including ranges
  without validators. Its embedded metadata is not inspected for URLs; do not
  apply the MP4 full-file inspection fallback to Matroska playback.
- Revalidate provider-only grants against current ownership/admin access, and
  channel-bound grants against current channel and provider-pool authorization.
- Every fixed provider URL grant must carry its selected `providerId`. Category
  resources for normal users also carry `user_channel_id`, including users with
  `provider_access`, so explicit admin channel grants keep working.
- Shared EPG catalog artwork uses current source/channel identity rather than a
  frozen upstream URL. Recheck source existence and the current EPG row; XMLTV
  artwork also rechecks the user's current mapping and share scope. Preserve
  shared EPG catalog visibility independently of provider management access.
- Review every grant issuer when changing provenance or revocation rules,
  including category, EPG, XMLTV, Stalker and metadata response paths.

## Package and Build Rules

- Primary package manager: `npm`.
- Docker and GitHub release use `package-lock.json` with `npm ci`.
- If dependencies change, update `package.json` and `package-lock.json`
  together.
- `pnpm-lock.yaml` may exist, but do not treat it as the Docker source of
  truth unless the build pipeline is changed too.

## Runtime Data Rules

Runtime data defaults to the repo root unless `DATA_DIR` is set. Docker uses
`DATA_DIR=/data`.

Never commit:

- `db.sqlite*`
- `epg.db*`
- `secret.key`
- `jwt.secret`
- `cache/`
- `temp_*`
- `temp_uploads/`

When running tests locally, prefer an isolated data dir for tests that touch the
real DB:

```bash
DATA_DIR="$(mktemp -d)" npm test
```

## Database and Migration Rules

- Migrations run from `initDb(true)` in the primary process before workers
  start.
- Migrations must be idempotent.
- Heavy migrations must be guarded by schema checks or marker rows in
  `settings`.
- Avoid repeated `VACUUM`, full-table rewrites, or unbounded startup work.
- Preserve existing user/provider/channel IDs unless a migration explicitly
  requires a remap.
- When changing user clone, import/export, provider sync, category mapping, or
  EPG mapping, add focused regression coverage.

## Docker Rules

- Docker runtime runs as non-root `app`.
- Do not recursively `chown /app` at container start. `/app` contains
  `node_modules`; recursive ownership fixes there can make startup very slow.
- `/data` ownership may be fixed for backward compatibility, but only when
  needed.
- Keep `.dockerignore` excluding local DBs, secrets, caches, temp data, reports,
  and host dependencies.

## Validation

Run available checks relevant to the change:

1. `npm run lint`
2. targeted `npm test -- <test file>` or `npm exec vitest run <test file>`
3. `npm test` when practical
4. `npm run build`

If full `npm test` fails because of existing unrelated tests or environment
paths, report the exact failing suites and run targeted coverage for the change.

Keep smoke coverage current for:

- Express app route registration and security middleware
- API and configuration documentation
- Docker and runtime-data ignore rules
- user clone/import/export/provider-sync regressions
- normal-user provider visibility and continued channel/movie/series/EPG list
  editing

The Playwright smoke test starts its own ephemeral server and uses a temporary
`DATA_DIR` when none is configured. Keep that isolation behavior so browser
tests do not write to the repository's runtime database.
