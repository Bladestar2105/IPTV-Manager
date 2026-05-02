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
- Do not commit runtime data, databases, secrets, cache files, or temp upload
  data.
- Do not introduce new dependencies unless clearly justified.
- Keep API responses backward-compatible unless explicitly requested.
- Avoid broad refactors in controllers that handle streaming, auth, provider
  sync, EPG, imports/exports, or database migrations.

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

