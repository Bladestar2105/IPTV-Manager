# Performance Analysis: Active Stream Tracking

## Current implementation

`StreamManager` uses Redis when `REDIS_URL` is configured and the connection
succeeds. Otherwise it uses SQLite. Both backends track active sessions and
apply the same connection-limit semantics.

### SQLite fallback

- Sessions are stored in `current_streams`.
- Prepared statements handle add, remove, cleanup, same-session lookup, counts,
  activity updates, and worker cleanup.
- The database has indexes for user/IP and provider lookups.
- Runtime stream rows are ephemeral and are cleared during primary database
  initialization.

### Redis backend

- `iptv:streams` stores session JSON by stream ID.
- `iptv:user_idx:<user_id>:<ip>` stores the current stream ID for the user/IP
  secondary index.
- Removing a stream deletes the secondary index only when it still points to
  that stream, then removes the stream hash entry. This prevents an older
  cleanup from deleting a newer session's index.

## Measured hotspots

The Redis implementations of provider counts and active-session checks read the
stream hash and scan the returned active sessions. Their cost is therefore
`O(n)` in the number of active Redis entries for each check. This is currently
simple and consistent with the SQLite fallback, but it should be measured at
realistic session counts before adding more indexes or scripting.

The large synchronization, import, proxy, authentication, and EPG parsing
paths remain high-complexity areas. They were intentionally not structurally
refactored in this audit because they combine provider compatibility, streaming,
authentication, and data-migration behavior. Any future split should be driven
by a focused profile and covered by path-specific regression tests.

## Recommended measurement path

1. Record stream-count lookup latency and event-loop delay at representative
   active-session counts for both backends.
2. If Redis hash scans dominate, evaluate a maintained per-provider/per-user
   index or an atomic Redis script. Add concurrency tests before changing the
   key model.
3. If SQLite write contention is observed, capture lock wait time and request
   latency first, then compare the same workload with Redis.

No fixed user-count threshold is claimed here: the useful limit depends on
client polling cadence, active-session count, hardware, provider latency, and
deployment topology.
