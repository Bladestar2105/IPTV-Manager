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
- Validated the experimental portal with real software clients.
- Hardware-specific MAG UI and favorites remain unsupported.
