# Changelog

All notable changes to this project are documented here.

## Unreleased

- Added a per-user provider-access setting that hides upstream provider
  management and catalog data from normal users by default while preserving
  their channel, movie, series, and category-scoped EPG mapping edits.
- Added isolated API and Playwright regression coverage for provider visibility,
  session cleanup, and retained list editing.
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
- Added explicit `assignment_origin` provenance (`manual`, `mapping`, `legacy`,
  or `imported`) and restricted mapping reconciliation to trusted mapping rows.
- Replaced unsafe V1 mapping inference with a conservative V2 repair that
  clears uncertain ownership while preserving assignment IDs and fields.
- Deterministically merge duplicate assignments during legacy backup restore,
  full-system import, cloning, and category import, including alias rebinding.
- Preserve trusted mapping provenance during version-2 system imports only after
  validating user, category, provider, provider-category, type, and stream
  relationships.
- Reuse and transactionally reconcile existing mapping targets during repeated
  category imports instead of stranding mapping-owned assignments.
- Group backup and system-import duplicate assignments before insertion so
  merged state and the lowest available assignment ID are independent of input
  order.
- Treat manual re-add as an explicit transfer from mapping ownership to manual
  ownership.
- Validated the experimental portal with real software clients.
- Hardware-specific MAG UI and favorites remain unsupported.
