# EPG download retry and SQLite temporary files

Goal: preserve the configured automatic EPG download interval after failed imports,
including restarts, and give Docker SQLite spill files a writable directory.

Use the existing source/provider rows for persistent attempt timestamps; keep
successful-update timestamps unchanged. Record immediately before the network
request in the shared importer. Scheduling uses the later timestamp. Existing
manual refresh behavior and source ownership locks remain intact.

The shared SQLite connection factory defaults to `${DATA_DIR}/sqlite-tmp`, honors
`SQLITE_TMPDIR`, creates the directory for the runtime user and checks actual file
creation before the first SQLite connection. This covers Docker, bare-metal,
systemd, Proxmox and manual starts. Keep file-backed SQLite temporary storage
rather than moving large EPG sorts into process memory. Production installers
use `npm ci --omit=dev`, matching the Docker lockfile. No new dependencies or
changes to live configuration. GitHub builds refresh Node 24/base-image patches,
use supported action majors and test SQLite spill storage before publication.

- [x] Demonstrate failures for attempt persistence, scheduler restart, migration
  idempotency and writable Docker temporary storage.
- [x] Add guarded timestamp migrations and shared-import attempt recording.
- [x] Update scheduler and shared SQLite startup, preserving non-root execution.
- [x] Update configuration/development documentation and validate targeted
  regressions, full tests, lint and build. Review the final connected change.

- [x] Recheck download eligibility under the existing cross-worker source lock.
- [x] Patch reported Vite, Vitest and ip-address vulnerabilities without adding
  dependencies or changing major versions; retain the CI security audit.
