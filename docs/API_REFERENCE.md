# API Reference

This file is a route inventory for maintainers and integration authors. Keep it
in sync when `src/routes/` changes.

Most `/api/*` endpoints require a valid JWT unless noted otherwise. Xtream,
stream, share, and HDHomeRun endpoints use their own token or credential checks.

## Auth

- `POST /api/login`
- `GET /api/verify-token`
- `POST /api/auth/otp/generate`
- `POST /api/auth/otp/verify`
- `POST /api/auth/otp/disable`
- `POST /api/change-password`
- `POST /api/player/token`

## Users

- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/:id`
- `DELETE /api/users/:id`

Deleting a user removes user-owned providers and dependent runtime/configuration
rows first, including provider icon cache entries, share links, temporary
tokens, user backups, sync data, categories, channels, and mappings. This keeps
SQLite foreign-key enforcement enabled while preventing orphaned user data.

## Providers

- `GET /api/providers`
- `POST /api/providers`
- `POST /api/providers/bulk-url`
- `PUT /api/providers/:id`
- `DELETE /api/providers/:id`
- `POST /api/providers/:id/sync`
- `GET /api/providers/:id/channels`
- `GET /api/providers/:id/categories`
- `POST /api/providers/:providerId/import-category`
- `POST /api/providers/:providerId/import-categories`

Deleting a provider removes dependent channel assignments, EPG mappings, stream
stats, sync data, category mappings, and provider icon cache entries before the
provider row is deleted.

`POST /api/providers/bulk-url` is admin-only. It replaces matching provider
base URLs across all users, for example `from_url: "http://provider1.com"` to
`to_url: "http://provider2.com"`. Default provider EPG URLs under
`/xmltv.php` are moved to the new base URL; custom EPG URLs stay unchanged.

## Categories and Channels

- `GET /api/users/:userId/categories`
- `POST /api/users/:userId/categories`
- `PUT /api/users/:userId/categories/reorder`
- `PUT /api/user-categories/:id`
- `DELETE /api/user-categories/:id`
- `POST /api/user-categories/bulk-delete`
- `PUT /api/user-categories/:id/adult`
- `GET /api/user-categories/:catId/channels`
- `POST /api/user-categories/:catId/channels`
- `PUT /api/user-categories/:catId/channels/reorder`
- `DELETE /api/user-channels/:id`
- `POST /api/user-channels/bulk-delete`
- `PUT /api/user-channels/:id`
- `GET /api/category-mappings/:providerId/:userId`
- `PUT /api/category-mappings/:id`

## EPG and Mapping

- `GET /api/epg/now`
- `GET /api/epg/schedule`
- `GET /api/epg/channels`
- `GET /api/epg-sources`
- `POST /api/epg-sources`
- `PUT /api/epg-sources/:id`
- `DELETE /api/epg-sources/:id`
- `POST /api/epg-sources/:id/update`
- `POST /api/epg-sources/update-all`
- `POST /api/epg-sources/clear`
- `GET /api/epg-sources/available`
- `POST /api/mapping/manual`
- `DELETE /api/mapping/:id`
- `GET /api/mapping/:providerId`
- `GET /api/mapping/jobs/:id`
- `POST /api/mapping/reset`
- `POST /api/mapping/suggest`
- `POST /api/mapping/auto`

`GET /api/epg/schedule` is scoped to the authenticated user's visible channels
and, for share guests, to the share's allowed channel list. The web player uses
this endpoint for timeline data after rendering the channel list.

`POST /api/mapping/auto` accepts `background: true` and returns a `job_id`.
Poll `GET /api/mapping/jobs/:id` for `status`, `progress`, and `matched`.
Admins may pass `all_providers: true` to auto-map or reset EPG mappings across
all providers.

## User Backups

- `GET /api/users/:userId/backups`
- `POST /api/users/:userId/backups`
- `POST /api/users/:userId/backups/:id/restore`
- `DELETE /api/users/:userId/backups/:id`

Restore recalculates channel authorization from current category and provider
ownership. A normal user's backup cannot recreate a historical administrator
grant: valid cross-owner rows are restored hidden and ungranted, while missing
references are skipped. An authenticated admin restore may deliberately create
a current cross-owner grant. The restore response includes non-sensitive
`channels_restored`, `channels_hidden`, and `channels_skipped` counters.

## System, Security, and Statistics

- `GET /api/settings`
- `POST /api/settings`
- `GET /api/client-logs`
- `POST /api/client-logs`
- `DELETE /api/client-logs`
- `GET /api/security/logs`
- `DELETE /api/security/logs`
- `GET /api/security/blocked`
- `POST /api/security/block`
- `DELETE /api/security/block/:id`
- `GET /api/security/whitelist`
- `POST /api/security/whitelist`
- `DELETE /api/security/whitelist/:id`
- `POST /api/export`
- `POST /api/import`
- `GET /api/sync-configs`
- `GET /api/sync-configs/:providerId/:userId`
- `POST /api/sync-configs`
- `PUT /api/sync-configs/:id`
- `DELETE /api/sync-configs/:id`

Sync configs accept an optional `sync_series_episodes` flag (default `1`).
When enabled, each provider sync also fetches series episodes via
`get_series_info` in the background (incremental, gated by each series'
`last_modified`) so `get.php` playlists can list every episode. Episode data
is stored once per upstream panel (keyed by the normalized provider URL):
provider entries that point at the same panel with different credentials
share the episode catalog instead of fetching and storing it per account.

Cross-owner sync configs require an explicit administrator approval. Send
`allow_cross_owner: true` when an admin intentionally creates or updates such a
config; the server persists this as `granted_by_admin = 1`. Unapproved
cross-owner configs remain disabled, and scheduled syncs never infer approval
from an owner mismatch. Same-owner configs are always normalized to
`granted_by_admin = 0`.
- `GET /api/sync-logs`
- `GET /api/statistics`
- `POST /api/statistics/streams/:streamId/terminate`
- `POST /api/statistics/reset`
- `POST /api/geoip/update`

`POST /api/geoip/update` stores a provided `license_key` when present, checks
MaxMind country/city checksums, and only starts the background updater when the
local GeoIP database is stale. It returns `up_to_date: true` when no download is
needed. Pass `force: true` to force the underlying updater.

## Shares

- `POST /api/shares`
- `PUT /api/shares/:token`
- `GET /api/shares`
- `DELETE /api/shares/:token`
- `GET /share/:slug`

New short-link slugs keep a readable name prefix and add a cryptographically
random suffix. Existing stored slugs remain valid. Public slugs and share
management tokens are treated as bearer credentials and redacted from request
logs.

## Proxy

- `GET /api/proxy/image`
- `DELETE /api/proxy/picons`

## Xtream and Player Compatibility

- `GET /cpp`
- `GET /player_api.php`
- `GET /player_api.php?action=get_live_categories`
- `GET /player_api.php?action=get_live_streams&category_id=<id>`
- `GET /player_api.php?action=get_vod_categories`
- `GET /player_api.php?action=get_vod_streams&category_id=<id>`
- `GET /player_api.php?action=get_series_categories`
- `GET /player_api.php?action=get_series&category_id=<id>`
- `GET /player_api.php?action=get_short_epg&stream_id=<id>&limit=<n>`
- `GET /player_api.php?action=get_simple_date_table&stream_id=<id>`
- `GET /player_api.php?action=get_simple_data_table&stream_id=<id>`
- `GET /player_api.php?action=get_epg_batch&stream_ids=<ids>&date=<YYYY-MM-DD>`
- `GET /get.php`
- `GET /xmltv.php`
- `GET /api/player/playlist`
- `GET /api/player/channels.json`

`xmltv.php` supports streaming HTTP gzip compression when the client sends
`Accept-Encoding: gzip`. Custom clients can also request the IPTV-Manager
extension `xmltv.php?gzip=1`; this is not an Xtream-specific parameter.

`get.php` expands each series into one playlist entry per episode
(`<Series Name> SXX EXX`) like a native Xtream panel, using episodes cached by
the provider episode sync (see `sync_series_episodes` on sync configs). Series
whose episodes have not been synced yet fall back to a single series-level
entry.

Expanded episode IDs bind the upstream episode to the exact authorized
`user_channel_id`. `get_series_info`, generated M3U entries, normal credentials,
and token-authenticated share routes use the same format. Provider-based legacy
episode IDs are rejected fail-closed; clients should refresh series metadata or
their playlist after upgrading. Live and movie stream IDs are unchanged.

## Stream Proxy

- `GET /live/mpd/:username/:password/:stream_id/*`
- `GET /live/:username/:password/:stream_id.ts`
- `GET /live/:username/:password/:stream_id.m3u8`
- `GET /live/:username/:password/:stream_id.mp4`
- `GET /live/segment/:username/:password/seg.ts`
- `GET /live/segment/:username/:password/seg.key`
- `GET /movie/:username/:password/:stream_id.:ext`
- `GET /series/:username/:password/:episode_id.:ext`
- `GET /movie/:username/:password/:stream_id.:ext?tracks=true`
- `GET /series/:username/:password/:episode_id.:ext?tracks=true`
- `GET /timeshift/:username/:password/:duration/:start/:stream_id.ts`
- `GET /timeshift/:username/:password/:duration/:start/:stream_id.m3u8`
- `GET /live/mpd/token/auth/:stream_id/*`
- `GET /live/token/auth/:stream_id.ts`
- `GET /live/token/auth/:stream_id.m3u8`
- `GET /live/token/auth/:stream_id.mp4`
- `GET /movie/token/auth/:stream_id.:ext`
- `GET /series/token/auth/:episode_id.:ext`
- `GET /movie/token/auth/:stream_id.:ext?audio_track=<index>`
- `GET /series/token/auth/:episode_id.:ext?audio_track=<index>`
- `GET /movie/token/auth/:stream_id.:ext?subtitle_track=<index>&subtitle_format=vtt`
- `GET /series/token/auth/:episode_id.:ext?subtitle_track=<index>&subtitle_format=vtt`
- `GET /timeshift/token/auth/:duration/:start/:stream_id.ts`
- `GET /timeshift/token/auth/:duration/:start/:stream_id.m3u8`

## HDHomeRun Emulation

- `GET /hdhr/:token/discover.json`
- `GET /hdhr/:token/device.xml`
- `GET /hdhr/:token/lineup_status.json`
- `GET /hdhr/:token/lineup.json`
- `GET /hdhr/:token/auto/v:channelId`
- `GET /hdhr/:token/stream/:stream_id.ts`
- `GET /hdhr/:token/movie/:stream_id.:ext`
