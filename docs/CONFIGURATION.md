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

## Per-User Provider Access

Administrators can enable the stored `provider_access` setting separately for
each normal user. It is disabled by default and controls only upstream provider
management and connection-details visibility. A user without it still receives
their own provider names/options and catalog rows so they can edit channel,
movie, and series lists, including category-scoped EPG mappings. Administrators
are not restricted by this setting.

## Optional AI

AI is configured in the **AI Assistant** Web UI, without additional environment
variables or services. The central policy is stored in `settings.ai_policy`;
it defaults to disabled. Administrators explicitly select allowed users by name and allowed functions,
may share an admin connection with selected users, and can allow private user
connections. A user must also activate their own AI preferences.

Automatic cleanup rules recheck account and Web UI access, the applicable user
and function allowlists, and both server and personal AI enablement before
applying. Revoked access skips application without deleting the stored rule.
Already confirmed literal rules do not require a model connection to run.

Public API targets require HTTPS. `internal_targets` allows exact normalized
base URLs (including proxy prefixes) for administrator-approved internal
services; it never allows CIDR ranges, metadata addresses, redirects or insecure
TLS. An approved internal endpoint may use HTTP and no key. This policy does
not change IPTV provider/EPG networking. See [AI setup](AI_INTEGRATION.md).

Connection API keys use the existing `ENCRYPTION_KEY`/`secret.key` AES-GCM
encryption. Keep that key backed up separately from the database; access to both
allows decryption. Ordinary user backups, clones and system exports do not
include AI connections. Re-enter credentials and retest after importing a user.

## Optional personal ChatGPT connection

A second, separate AI connection type lets each user and each administrator link
**their own** ChatGPT account through the official Codex sign-in, without an
OpenAI platform API key. It is **disabled by default** and is offered only when
the server can prove that the Codex runtime is contained by an operating-system
sandbox. It never replaces the API connection type described above.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_CODEX_ENABLED` | `false` | Master switch. While false, nothing is started and the connection type is not offered. |
| `AI_CODEX_BIN` | `codex` | Path to the pinned Codex CLI, or a bare name resolved once against `PATH`. A relative path is resolved against the manager's working directory. The resolved absolute path is both version-probed and launched; the executable, the target of a symlinked launcher and the interpreter of a script launcher are bound read-only as individual files, and a resolved package root as a directory, so a global npm install works without carrying a launcher's unrelated neighbours into the sandbox. A launcher placed in or above `DATA_DIR` is refused (`AI_CODEX_BINARY_UNSAFE_LOCATION`), because mounting it would expose the database and the encryption key; keep it in a normal system location. Its reported version must fall inside the tested range (see [AI setup](AI_INTEGRATION.md)). |
| `AI_CODEX_RUNTIME_DIR` | `$DATA_DIR/ai-codex` | Root for per-identity runtime directories, created with mode `0700`. Wherever it is placed, the sandbox masks the whole root and restores only the identity that is running, so one identity never reaches another's. |
| `AI_CODEX_SANDBOX` | `auto` | Isolation backend: `auto`, `bwrap`, `sandbox-exec`, or `none` to keep the adapter disabled. |
| `AI_CODEX_ALLOW_DEV_SANDBOX` | `false` | Accept a development-grade backend (macOS `sandbox-exec`). Not intended for hosted multi-user operation. |
| `AI_CODEX_VERSION_OVERRIDE` | unset | Accept one exact Codex version outside the tested range. Use only for a deliberate, separately validated upgrade. |

On Linux the supported backend is **bubblewrap** (`bwrap`), which gives the
runtime its own mount, PID, IPC, UTS and cgroup namespaces with only its own
identity directory writable. Install it in the image or host (`apt-get install
-y bubblewrap`) and keep the web process unprivileged; no Docker socket and no
host administration rights are required or granted. On startup the server runs a
canary self-test that must fail to read a file outside the sandbox and fail to
write into `DATA_DIR`. If the backend is missing, the self-test fails, or the
grade is only development, the adapter stays unavailable with a specific reason
and the connection type is not offered.

Credentials are stored encrypted with the same `ENCRYPTION_KEY`/`secret.key`.
The Codex credential file exists in clear text only inside the identity's own
`0700` directory while its runtime is live and is removed when it stops. The
server operator can read the application key by design; this is not encryption
against the operator.

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
  workers or instances. When Redis is unavailable or not configured, the
  SQLite `current_streams` table is used instead.
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
