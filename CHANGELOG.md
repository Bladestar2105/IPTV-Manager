# Changelog

All notable changes to this project are documented here.

## Unreleased

- Hardened tenant-scoped category and channel operations.
- Validated category mapping targets before writes.
- Preserved explicit cross-owner provider selection priority.
- Kept stored movie extensions authoritative for playback links.
- Cleaned up series alias lifecycle with cascading assignment removal.
- Added a one-time authorization migration marker.
- Made bulk channel deletion atomic with validated IDs and accurate counts.
- Added an experimental software-client Stalker portal with live TV, VOD,
  synchronized series, radio, EPG, and catch-up support.
- Added MAC-authenticated, revocable Stalker sessions and bounded bulk EPG
  responses.
- Added provider-timezone-aware catch-up formatting with epoch-preserving
  internal archive links.
- Reject internal epoch catch-up links for programmes that have not ended.
- Synchronize radio category mappings for live provider channels alongside live
  mappings without duplicating provider channels.
- Run bulk category deletion and channel hiding validation and writes in one
  transaction with post-commit cache invalidation.
- Delete stale provider channels with their EPG, statistics, assignment, and
  series-alias dependents before removing the provider row.
- Synchronize large live, movie, and series catalogs without unbounded SQLite
  placeholder lists.
- Require two consecutive authoritative empty snapshots before removing an
  existing content catalog.
- Reconcile mapping-owned assignments when mappings are retargeted or removed,
  while preserving manual assignments and hidden state.
- Backfill legacy `mapping_id` values only for unambiguous matches and merge
  duplicate user-channel assignments before enforcing uniqueness.
- Validated the experimental portal with real software clients.
- Hardware-specific MAG UI and favorites remain unsupported.
