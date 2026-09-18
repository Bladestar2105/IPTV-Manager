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

## SQLite

Every SQLite connection in the process is opened through
`src/database/sqliteConnection.js` so the lock behavior is identical in the
request path, the schedulers, and the EPG import. Both databases run in WAL
mode.

- `SQLITE_BUSY_TIMEOUT_MS`: How long a statement waits for a lock held by
  another connection or worker. Defaults to `30000`, clamped to
  `1000`–`300000`. It must stay above the longest write transaction the
  application performs; a provider sync or a provider deletion can hold the
  write lock for tens of seconds. Too low a value turns ordinary contention
  into `database is locked`.
- `SQLITE_LATENCY_BUSY_TIMEOUT_MS`: Lock wait for connections on latency
  critical paths, currently the stream activity heartbeat. Defaults to `250`
  and is never longer than `SQLITE_BUSY_TIMEOUT_MS`. better-sqlite3 is
  synchronous and its busy handler sleeps on the main thread, so a long wait
  blocks the whole worker — including every stream it is pumping. Losing one
  activity update is cheaper than stalling playback.
- `SQLITE_WAL_SIZE_LIMIT_BYTES`: Upper bound for a `-wal` file after a
  checkpoint. Defaults to `67108864` (64 MB), minimum `1048576`. Without the
  limit a checkpointed WAL is reused in place and never shrinks again.
- `SQLITE_CHECKPOINT_INTERVAL_MS`: How often the primary process runs a passive
  WAL checkpoint on both databases. It runs in the primary because a checkpoint
  is synchronous and can copy a large WAL; the primary serves no traffic. Defaults to `300000` (5 minutes), minimum
  `30000`. SQLite only auto-checkpoints at the end of a write transaction and a
  checkpoint cannot reclaim frames an active reader still needs, so without this
  the WAL of a busy instance can grow past the size of the database itself. The
  checkpoint is `PASSIVE` and therefore never waits for a reader.

## Per-User Provider Access

Administrators can enable the stored `provider_access` setting separately for
each normal user. It is disabled by default and controls only upstream provider
management and connection-details visibility. A user without it still receives
their own provider names/options and catalog rows so they can edit channel,
movie, and series lists, including category-scoped EPG mappings. Administrators
are not restricted by this setting.

## Optional AI

The AI integration is **experimental**, including both API and ChatGPT connections.
API connections are configured in the **AI Assistant** Web UI, without additional
environment variables or services. Personal ChatGPT connections also need the
runtime described below. The central policy is stored in `settings.ai_policy`;
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
OpenAI platform API key. Packaged installations enable the runtime; AI access
still requires the administrator's policy and each user's preferences. It is offered only when
the server can prove that the Codex runtime is contained by an operating-system
sandbox. It never replaces the API connection type described above.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_CODEX_ENABLED` | `false` in the standard Compose stack; `true` in the ChatGPT overlay, image, installer and example environment; otherwise `false` | Master switch. While false, nothing is started and the connection type is not offered. Existing explicit settings are preserved by the updater. |
| `AI_CODEX_BIN` | `codex` | Path to the pinned Codex CLI, or a bare name resolved once against `PATH`. A relative path is resolved against the manager's working directory. The resolved absolute path is both version-probed and launched; the executable, the target of a symlinked launcher and the interpreter of a script launcher are bound read-only as individual files, and a resolved package root as a directory, so a global npm install works without carrying a launcher's unrelated neighbours into the sandbox. A launcher placed in or above `DATA_DIR` is refused (`AI_CODEX_BINARY_UNSAFE_LOCATION`), because mounting it would expose the database and the encryption key; keep it in a normal system location. Its reported version must fall inside the tested range (see [AI setup](AI_INTEGRATION.md)). |
| `AI_MODEL_TEST_BATCH_MS` | `300000` | Budget for one whole compatibility test, however many models and probes it contains (clamped to 1 s – 15 min). Set it to the timeout of the proxy in front of the manager: there is no point in still making billable calls for a request nothing is waiting for. Models the batch could not reach are reported as untested. |
| `AI_CODEX_RUNTIME_DIR` | `$DATA_DIR/ai-codex` | Root for per-identity runtime directories, created with mode `0700`. A relative path — including one inherited from a relative `DATA_DIR` — is resolved against the working directory, because the sandbox needs absolute paths. Wherever it is placed, the sandbox masks the whole root and restores only the identity that is running, so one identity never reaches another's. |
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

### AI installation verification

The standard Docker image and Debian/Ubuntu installer provision Codex **0.154.0**
and bubblewrap. Manual Debian/Ubuntu installations run
`sudo bash scripts/install-ai-runtime.sh` after installing Node.js and npm.
Proxmox delegates to that same installer inside its unprivileged, nesting-enabled
container. Existing explicit `AI_CODEX_ENABLED=false` settings are not changed.
If optional ChatGPT provisioning fails during install/update, a warning is
reported and the core server installation/restart continues. Correct the reported
dependency problem and rerun the helper before using ChatGPT.

Run `npm run check:ai-runtime` **as the application user, not root**. It uses
temporary data, checks real filesystem containment, probes the installed
version, starts the app-server with the production restrictions and completes
its protocol handshake. It never signs in, loads existing credentials, or calls
a model. A missing/blocked runtime produces a nonzero exit code. Install/update
run it with `--if-enabled`; a failure warns rather than stopping the ordinary
server and API connection path.

Personal ChatGPT connections in Docker need the optional `docker-compose.chatgpt.yml`
overlay and the supplied `docker/ai-seccomp.json` and, on AppArmor hosts, the
loaded `iptv-manager-ai` profile in `docker/ai-apparmor`. Keep Docker's default
masked/read-only paths, capability set and PID isolation. Do **not** use
`privileged`, `SYS_ADMIN`, `seccomp=unconfined`, `apparmor=unconfined` or
`systempaths=unconfined`. The runtime uses a read-only synthetic `/proc` containing
only its fixed executable link; it exposes no process tree and does not need
to mount procfs inside Docker. The profile provenance and permissions are in
[docker/SECURITY-PROFILES.md](../docker/SECURITY-PROFILES.md).
The standard Compose/Portainer stack uses Docker defaults with
`AI_CODEX_ENABLED=false`; AI API connections remain available. Missing sandbox
files cannot be repaired by replacing the image, since Docker reads them before
container startup. See the [Portainer repair steps](../README.md#using-docker-compose-or-portainer).

On AppArmor-enabled Debian/Ubuntu hosts the helper installs a private,
root-owned bubblewrap executable under `/usr/local/lib/iptv-manager/bwrap`
and its enforced `iptv-manager-bwrap` profile. The application selects that
executable when present, otherwise the system bubblewrap. This leaves the
system-wide unprivileged-user-namespace restriction and other applications'
bubblewrap unchanged. A container that cannot load this profile needs its host
administrator; the helper reports that restriction rather than disabling it.

After a green preflight, configure the AI policy/preferences and complete a real
Web UI account link, model discovery/test, and disconnect. API-key connections
require their own endpoint/key/model test. These account-dependent checks are
separate from installation verification. Proxmox remains runtime-unverified
until this is exercised on a real Proxmox host.

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
- `HTTP_MAX_REQUEST_MS`: Upper bound for the wait for response headers of one
  outgoing request through the SSRF-safe fetch path, across the whole redirect
  chain. Defaults to `600000` (10 minutes), minimum `1000`. The per-call
  `timeout` bounds each single hop, but never beyond what is left of this
  budget — so setting this low shortens every hop too.
  The **body is not bounded here**. Most bodies this path returns are media
  proxied to a player, and a healthy live session legitimately outlives any
  fixed duration — bounding them by default means one missed call site cuts a
  viewer's stream. Callers that buffer a finite document (provider catalogs,
  series info, EPG metadata, proxied images) bound the read themselves with
  `readBodyWithLimit()`, which owns both the time and the size cap.
- `CATALOG_BODY_TIMEOUT_MS`: Budget for reading one provider catalog document
  (live/VOD/series lists and their categories). Defaults to `300000`
  (5 minutes), minimum `1000`; a large VOD catalog is hundreds of megabytes.
- `CATALOG_BODY_MAX_BYTES`: Size cap for the same read. Defaults to
  `536870912` (512 MB), minimum `1048576`, far above a real catalog: buffering,
  decoding and parsing one costs several times its wire size in heap at the same
  moment, so a body that never ends has to be refused on size as well as on
  time.
- `MANIFEST_BODY_TIMEOUT_MS` / `MANIFEST_MAX_BYTES`: Budget and size cap for
  reading an MPD or M3U8 manifest in the stream proxy. Default `30000` and
  `33554432`, minimum `1000` and `65536`. Without them an upstream that sends
  manifest headers and then stalls holds the request and its stream session open
  indefinitely.

Every numeric setting in this document — not only the budgets above — takes a
**plain integer, with no unit suffix**. `30s`,
`10m` and `512MB` are refused outright and the default is used — not read as 30,
10 and 512, which is what `parseInt` would do and which would silently turn a
five minute budget into one second. A value that is a clean integer is honoured
and only clamped when it falls outside the supported range. Every refusal and
every clamp is logged, naming the variable: an operator should never have to
infer a typo from the symptom.
- `EPG_IMPORT_BODY_TIMEOUT_MS`: Total budget for receiving and parsing one EPG
  feed. Defaults to `1800000` (30 minutes), minimum `1000`. The EPG body is streamed into the
  parser rather than buffered, so it needs its own deadline; without one an
  import has no upper bound and no age can tell a live one from an abandoned
  one.

## Stream Tracking

- `REDIS_URL`: Optional Redis connection URL for active stream tracking across
  workers or instances. When Redis is unavailable or not configured, the
  SQLite `current_streams` table is used instead.
- `STREAM_MAX_AGE_MS`: Hard safety cap for stale stream sessions. Defaults to
  `86400000` (24 hours).
- `STREAM_INACTIVITY_TIMEOUT_MS`: Inactivity timeout for stream sessions.
  Defaults to `120000` (2 minutes).
- `STREAM_TOUCH_MIN_INTERVAL_MS`: Smallest gap between two activity updates of
  the same session. Defaults to a quarter of `STREAM_INACTIVITY_TIMEOUT_MS` and
  is clamped to at most half of it, so a session can never time out because its
  refresh was throttled. Without this, every ffmpeg progress event became an
  `UPDATE current_streams`, which collided with long write transactions.

## Scheduled Jobs and GeoIP

- `IS_SCHEDULER`: Internal cluster flag used by the primary process when
  starting the scheduler worker.
- `SYNC_MAX_CONCURRENT`: How many scheduled provider syncs may run at the same
  time. Defaults to `2`, minimum `1`. Configs above the limit keep their
  `next_sync` and are picked up by a later tick, longest overdue first, so no
  provider can be starved by the order of the table. Without the cap every due
  config started at once, and `next_sync` values cluster — after a restart, or
  when a shared upstream failed them together — so several hundred-megabyte
  catalogs were decoded and parsed concurrently in one container.

  The scheduler starts at most this many per 60-second tick, so the sustainable
  throughput is `SYNC_MAX_CONCURRENT` syncs per `max(sync duration, 60s)`. If
  that is below what the configured intervals demand, the backlog grows and the
  scheduler says so — `⏳ N due provider sync(s) waiting` — at most once every
  15 minutes. Raise the cap, or lengthen the intervals.
- `MAXMIND_LICENSE_KEY`: Optional MaxMind license key for GeoLite2 updates.
  The Web UI security settings can also provide this value. Startup checks
  MaxMind checksum files first and skips the heavy `geoip-lite` updater when
  the local GeoIP database is already current.

## EPG Downloads

- `EPISODE_SYNC_MAX_CONSECUTIVE_FAILURES`: How many consecutive *upstream*
  failures stop an episode sync for one provider account. Defaults to `25`,
  minimum `5`. A panel that stops answering `get_series_info` does not recover
  within one run, and a queue can hold tens of thousands of series. The count is
  per account, not per panel: several provider rows commonly share one panel,
  and an account whose subscription lapsed fails every request while the panel
  itself is healthy. Its series are skipped for the rest of the run and the
  other accounts continue. A local write failure never counts — it says the
  database is the problem, not the panel.
- `EPISODE_SYNC_GIVE_UP_COOLDOWN_SECONDS`: How long a panel stays off limits
  after a run gave up on it — that is, after *every* provider account on that
  panel hit the limit above. **In seconds**, unlike its neighbours here.
  Defaults to `1800` (30 minutes), minimum `60`, maximum `21600` (6 hours): the
  cooldown is a lease nobody renews, it survives restarts and can only be waited
  out, so a value entered in milliseconds by habit must not cost weeks of
  episode syncs.
  Without the cooldown each provider row takes the freed lock in turn and spends
  its own full failure budget against the same dead host.
- `EPG_STAGE_SWEEP_INTERVAL_MS`: How often the primary looks for the leftovers
  of a killed EPG import — staging tables and an `epg_sources.is_updating` flag
  nothing will clear. Defaults to `3600000` (1 hour), minimum `60000`. Imports
  run in a worker and the stale threshold below is hours, so a worker killed
  mid-import is restarted long before the next cold start could reclaim
  anything; sweeping only at startup meant, in practice, never.
- `EPG_STAGE_STALE_MS`: Age after which a leftover EPG staging table counts as
  abandoned, and after which the `is_updating` flag of a source with no fresher
  table is cleared. Both are done at startup and by the periodic sweep above. Defaults to `21600000` (6 hours). The
  effective value is never below four times `EPG_IMPORT_BODY_TIMEOUT_MS`,
  because that is how long a live import of another process may legitimately
  run, and the sweep must not classify it as stale during an overlapping
  restart.

EPG imports still validate URLs with the SSRF-safe fetch path, including
redirect re-checks and DNS rebinding protection. HTTPS EPG sources may use
self-signed certificates; this exception is scoped to EPG downloads and does
not disable TLS certificate validation globally or for stream proxy requests.

## Logging

Every line carries the emitting process id (`[<timestamp>] [w<pid>] ...`). The
cluster interleaves the output of one primary and one worker per CPU in a single
stream, so without it two adjacent lines cannot be attributed to a run or to two
workers competing for the same lock. SQLite failures additionally carry the
error code (`database is locked [SQLITE_BUSY]`), because the same message is
produced by a writer that waited out its busy timeout and by a deferred
transaction whose read snapshot went stale.

The Compose file configures `json-file` log rotation (`max-size: 20m`,
`max-file: 5`). Without it Docker keeps one unbounded file, and a past incident
can no longer be reconstructed once it has been truncated or lost.

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
