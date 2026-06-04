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
- `API_RATE_LIMIT_MAX`: Maximum requests per IP for general `/api`,
  Xtream API, XMLTV, and playlist endpoints within
  `API_RATE_LIMIT_WINDOW_MS`. Defaults to `1000`.
- `API_RATE_LIMIT_WINDOW_MS`: General API rate limit window in milliseconds.
  Defaults to `60000` (1 minute).
- `AUTH_RATE_LIMIT_MAX`: Maximum requests per IP for login, password changes,
  user creation/update, and backup restore/create endpoints within
  `AUTH_RATE_LIMIT_WINDOW_MS`. Defaults to `100`.
- `AUTH_RATE_LIMIT_WINDOW_MS`: Authentication-sensitive rate limit window in
  milliseconds. Defaults to `900000` (15 minutes).
- `CLIENT_LOG_RATE_LIMIT_MAX`: Maximum unauthenticated client log submissions
  per IP within `CLIENT_LOG_RATE_LIMIT_WINDOW_MS`. Defaults to `120`.
- `CLIENT_LOG_RATE_LIMIT_WINDOW_MS`: Client log rate limit window in
  milliseconds. Defaults to `3600000` (1 hour).

## Stream Tracking

- `REDIS_URL`: Optional Redis connection URL for active stream tracking across
  workers or instances. Without Redis, in-memory tracking is used.
- `STREAM_MAX_AGE_MS`: Hard safety cap for stale stream sessions. Defaults to
  `86400000` (24 hours).
- `STREAM_INACTIVITY_TIMEOUT_MS`: Inactivity timeout for stream sessions.
  Defaults to `120000` (2 minutes).

## Scheduled Jobs and GeoIP

- `IS_SCHEDULER`: Internal cluster flag used by the primary process when
  starting the scheduler worker.
- `MAXMIND_LICENSE_KEY`: Optional MaxMind license key for GeoLite2 updates.
  The Web UI security settings can also provide this value. Startup checks
  MaxMind checksum files first and skips the heavy `geoip-lite` updater when
  the local GeoIP database is already current.

## EPG Downloads

EPG imports still validate URLs with the SSRF-safe fetch path, including
redirect re-checks and DNS rebinding protection. HTTPS EPG sources may use
self-signed certificates; this exception is scoped to EPG downloads and does
not disable TLS certificate validation globally or for stream proxy requests.

## Docker Notes

The Docker image builds on Node.js 24 Alpine and uses `/data` for mutable
runtime files and `/app` for application code and dependencies. The entrypoint
may recursively fix ownership of `/data` for older root-owned volumes, but it
must not recursively chown `/app` because `/app/node_modules` can be large and
make startup slow. GeoIP updates are persisted under `/data/geoip` by symlinking
`/app/node_modules/geoip-lite/data` there at container start, so updated MaxMind
data survives container recreation.

Keep runtime files out of Git and Docker build context:

- `db.sqlite*`
- `epg.db*`
- `secret.key`
- `jwt.secret`
- `cache/`
- `temp_*`
- `temp_uploads/`
