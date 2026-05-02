# Configuration

This file documents runtime configuration used by the server, Docker image, and
tests. Keep it in sync when environment variables or startup behavior changes.

## Core Runtime

- `PORT`: HTTP port. Defaults to `3000`.
- `NODE_ENV`: Enables production behavior such as secure cookies when set to
  `production`.
- `DATA_DIR`: Directory for runtime databases, secrets, uploads, and cache.
  Defaults to the repository root in local runs. Docker sets `DATA_DIR=/data`.
- `JWT_EXPIRES_IN`: Admin JWT lifetime. Defaults to `30d`.
- `BCRYPT_ROUNDS`: Bcrypt cost factor. Defaults to `10`.
- `JWT_SECRET`: Optional static JWT secret. If omitted, `jwt.secret` is created
  under `DATA_DIR`.
- `ENCRYPTION_KEY`: Optional static encryption key. If omitted, `secret.key` is
  created under `DATA_DIR`.
- `INITIAL_ADMIN_PASSWORD`: Optional first admin password. If omitted, a random
  password is generated and printed on first startup.

## Network and Proxy

- `TRUST_PROXY`: Express trust proxy setting. Use this behind a reverse proxy
  that terminates HTTPS or forwards client IPs.
- `ALLOWED_ORIGINS`: Comma-separated CORS allowlist. By default cross-origin
  browser requests are blocked. `*` allows all origins and is not recommended
  for production.

## Stream Tracking

- `REDIS_URL`: Optional Redis connection URL for active stream tracking across
  workers or instances. Without Redis, in-memory tracking is used.
- `STREAM_MAX_AGE_MS`: Hard safety cap for stale stream sessions. Defaults to
  `86400000` (24 hours).
- `STREAM_INACTIVITY_TIMEOUT_MS`: Optional inactivity timeout for stream
  sessions. Defaults to `0` (disabled).

## Scheduled Jobs and GeoIP

- `IS_SCHEDULER`: Internal cluster flag used by the primary process when
  starting the scheduler worker.
- `MAXMIND_LICENSE_KEY`: Optional MaxMind license key for GeoLite2 updates.
  The Web UI security settings can also provide this value.

## Docker Notes

The Docker image uses `/data` for mutable runtime files and `/app` for
application code and dependencies. The entrypoint may recursively fix ownership
of `/data` for older root-owned volumes, but it must not recursively chown
`/app` because `/app/node_modules` can be large and make startup slow.

Keep runtime files out of Git and Docker build context:

- `db.sqlite*`
- `epg.db*`
- `secret.key`
- `jwt.secret`
- `cache/`
- `temp_*`
- `temp_uploads/`
