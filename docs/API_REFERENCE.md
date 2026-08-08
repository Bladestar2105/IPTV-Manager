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
- `GET /api/users/:userId/stalker-devices`
- `POST /api/users/:userId/stalker-devices`
- `PUT /api/users/:userId/stalker-devices/:deviceId`
- `DELETE /api/users/:userId/stalker-devices/:deviceId`

Stalker device create/update payloads accept an optional `parental_pin` containing
4–8 digits. An empty or `null` value clears it. Device responses never contain
the PIN or its encrypted value and expose only `parental_pin_configured`.

User create/update payloads accept an optional `provider_access` boolean. It is
disabled by default and controls whether the normal user may view their
upstream providers and provider catalog.

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

Provider synchronization treats a complete empty response conservatively: one
empty snapshot preserves an existing local catalog, while a second consecutive
authoritative empty snapshot permits cleanup. Failed, invalid, or incomplete
responses do not advance the empty-snapshot counter. A provider with no local
rows may accept an empty catalog immediately.

`POST /api/providers/bulk-url` is admin-only. It replaces matching provider
base URLs across all users, for example `from_url: "http://provider1.com"` to
`to_url: "http://provider2.com"`. Default provider EPG URLs under
`/xmltv.php` are moved to the new base URL; custom EPG URLs stay unchanged.

Provider create/update payloads accept an optional `timeshift_timezone` IANA
name (for example `Europe/Berlin` or `UTC`). Empty or null uses the server
runtime timezone; invalid names are rejected. Provider export/import and user
provider cloning preserve this setting.

Normal users receive only their own providers and provider catalog when
`provider_access` is enabled; otherwise these provider endpoints return `403`.

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

Reorder requests accept unique positive integer IDs only. Category reorder IDs
must all belong to the route user, and channel reorder IDs must all belong to
the route category; otherwise the complete request is rejected without writes.
Category mappings accept `null` for an explicit unmap, or a category owned by
the mapping user with the same content type. Invalid, foreign, and mixed-type
targets are rejected without changing the mapping.

Assignments carry an explicit `user_channels.assignment_origin` constrained to
`manual`, `mapping`, `legacy`, or `imported`. Manual assignments are user-owned
and are never moved or removed by category mapping reconciliation. Mapping
assignments are owned by one `category_mappings.id` and may be moved, merged,
or removed. Legacy and imported assignments remain unmanaged until explicitly
adopted. A manual re-add of an existing assignment adopts it as `manual` and
clears `mapping_id`.

Mapping reconciliation requires both `assignment_origin = 'mapping'` and a
matching `mapping_id`; a non-null ID alone is not trusted. Each user category
can contain at most one assignment for a given provider channel. Bulk category
and channel requests accept at most 5,000 IDs per request.

Repeated provider-category imports reuse an existing valid mapping target and
merge missing mapping-owned assignments into it. Mapping ownership is retained
only when the user, target category, provider, provider category, content type,
and provider stream are compatible; invalid provenance remains unowned instead
of retaining a stale mapping reference. Backup and full-system import payloads
are grouped before insertion, so merged state and the lowest available
assignment ID do not depend on source row order.

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

Provider-scoped mapping reads require the same provider ownership and
`provider_access` permission as provider catalog reads.

Category-scoped EPG mapping remains available to normal users without
`provider_access`; it is limited to their own categories and authorized
channels. This also applies to manual mapping, reset, auto-mapping, and
category-mapping edits.

## User Backups

- `GET /api/users/:userId/backups`
- `POST /api/users/:userId/backups`
- `POST /api/users/:userId/backups/:id/restore`
- `DELETE /api/users/:userId/backups/:id`

Restore recalculates channel authorization from current category and provider
ownership. A normal user's backup cannot recreate a historical administrator
grant: cross-owner rows are restored with `authorization_revoked = 1`, while
their user-selected `is_hidden` value remains separate and missing references
are skipped. An authenticated admin restore may deliberately create a current
cross-owner grant only by sending `allow_cross_owner: true`; omitted or false
values keep those rows revoked with grant `0`. The restore response
includes non-sensitive `channels_restored`, `channels_hidden`, and
`channels_skipped` counters.

New backups use `format_version: 2` and
`assignment_provenance_version: 1`. Only a mapping present in the backup,
belonging to the restored user, and targeting the restored category/provider
relationship may retain mapping ownership. Legacy or unversioned backups treat
all assignments as imported and unowned. Duplicate assignments are merged by
category/provider-channel identity: manual wins over legacy/imported, which
wins over mapping; hidden state wins; custom names and lowest valid sort order
are deterministic; authorization is recalculated fail-closed. The optional
`channels_merged` counter reports merged rows without inflating restored rows.

## System, Security, and Statistics

- `GET /api/settings`
- `POST /api/settings`
- `GET /api/client-logs`
- `POST /api/client-logs`
- `DELETE /api/client-logs`

`POST /api/client-logs` accepts unauthenticated client log submissions and is
protected by the client-log rate limiter. `GET` and `DELETE` require an admin
JWT.

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
cross-owner creates are rejected with HTTP 400, existing unapproved configs
remain disabled, and scheduled syncs never infer approval from an owner
mismatch. Same-owner configs are always normalized to
`granted_by_admin = 0`.

Manual cross-owner provider syncs likewise require `allow_cross_owner: true`.
Adding `restore_revoked_assignments: true` clears only
`authorization_revoked` on assignments covered by that approved sync and sets
their administrator grant; it does not clear `is_hidden`. An administrator can
explicitly restore one legacy pre-release row through the normal channel
assignment endpoint, which clears both states for that selected channel only.

Full system imports validate stored grant and revocation flags against the
rebuilt ownership relationships. Imported cross-owner administrator grants are
restored only when the admin import request also includes
`allow_cross_owner: true`; otherwise their sync configs remain disabled and
their channel assignments remain authorization-revoked.

New full-system exports use `version: 2` with
`assignment_provenance_version: 1`. Modern mapping provenance is retained only
when the mapping was recreated for the imported user/category/provider. Older
or unversioned exports restore assignments as imported and unowned. Duplicate
assignments are merged with the same deterministic policy as backup restore;
`stats.channels` counts unique inserted assignments and `channels_merged` and
`channels_skipped` report the corresponding outcomes.

Radio categories are user-facing mappings of live provider channels. Xtream
providers expose live, VOD, and series streams, not a separate standard radio
stream/category action. A live provider category may be mapped to both live
and radio user categories, and automatic synchronization maintains both
mappings independently. The same provider channel record is reused while each
user-facing mapping has its own `user_channels` assignment.
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

- `GET /api/proxy/image?url=<url>&provider_id=<id>` (`provider_id` optional)
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
whose episodes have not been synced yet are omitted because a series assignment
ID is not a playable episode ID. Provider synchronization populates the episode
cache in the background; playlist requests never wait indefinitely for it.

Provider-controlled container extensions are normalized when stored and again
when a public or upstream URL is generated. Known MIME types are mapped to
their standard suffixes, and values containing path, query, fragment, percent,
control, or playlist-injection characters fall back to a safe extension.

Expanded episodes use compact persistent alias IDs from `900,000,001` through
`999,999,999`, safely within the signed 32-bit range and below the legacy ID
namespace. Each alias binds the upstream source, series, episode, and exact
authorized `user_channel_id`; `get_series_info`, generated M3U entries, normal
credentials, and token-authenticated share routes use the same IDs. Cached
provider- or assignment-based legacy IDs are accepted only when they resolve to
exactly one currently authorized series and episode, otherwise playback fails
closed.

Channel visibility requires `is_hidden = 0`, `authorization_revoked = 0`, and
either matching provider/category ownership or `granted_by_admin = 1`.
Ownership changes revoke ordinary assignments without changing the user's
hidden preference. Same-owner assignments normalize to grant `0`; explicit
cross-owner administrator assignments normalize to grant `1`.
Clients should refresh series metadata or playlists when a stale ID is
ambiguous. Live and movie stream IDs are unchanged.

The public episode URL suffix is compatibility metadata. Upstream and backup
requests use the normalized `container_extension` stored for the exact episode.
On first startup after upgrading, the rebuildable episode cache is recreated
when its old source-wide uniqueness key is detected; the next provider sync
repopulates it with series-scoped keys.

## Stream Proxy

- `GET /live/mpd/:username/:password/:stream_id/*`
- `GET /live/:username/:password/:stream_id.ts`
- `GET /live/:username/:password/:stream_id.m3u8`
- `GET /live/:username/:password/:stream_id.mp4`
- `GET /live/:username/:password/:stream_id.mp3`
- `GET /live/:username/:password/:stream_id.aac`
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
- `GET /live/token/auth/:stream_id.mp3`
- `GET /live/token/auth/:stream_id.aac`
- `GET /movie/token/auth/:stream_id.:ext`
- `GET /series/token/auth/:episode_id.:ext`
- `GET /movie/token/auth/:stream_id.:ext?audio_track=<index>`
- `GET /series/token/auth/:episode_id.:ext?audio_track=<index>`
- `GET /movie/token/auth/:stream_id.:ext?subtitle_track=<index>&subtitle_format=vtt`
- `GET /series/token/auth/:episode_id.:ext?subtitle_track=<index>&subtitle_format=vtt`
- `GET /timeshift/token/auth/:duration/:start/:stream_id.ts`
- `GET /timeshift/token/auth/:duration/:start/:stream_id.m3u8`

## Stalker/MAG (Experimental)

- `GET|POST /portal.php`
- `GET|POST /server/load.php`
- `GET|POST /stalker_portal/server/load.php`
- `GET|POST /c/server/load.php`
- `GET /c/`
- `GET /stalker_portal/c/` (canonical portal URL)

The public compatibility endpoints implement MAC handshake/session
authentication plus `do_auth`, `get_profile`, `get_modules`, `get_localization`,
`get_main_info`, `get_time`, `get_genres`, `get_ordered_list`,
`get_all_channels`, `get_short_epg`, `get_epg_info`, `get_simple_data_table`,
and `create_link`.
`get_ordered_list` uses 1-based pages, with `p=0` accepted as a page-one
compatibility alias, and accepts either `genre` or `category`.
`get_all_channels` excludes adult categories; an authenticated explicit adult
genre request remains available through `get_ordered_list`.

An optional per-device 4–8 digit parental PIN is encrypted at rest and returned
only as `parent_password` in that device's authenticated profile. Without a
configured PIN, that profile field is empty. Adult channels are excluded from
the bulk all-channels list, but an authenticated session can explicitly request
an adult category. Enforcement is primarily the client's Stalker parental
control; the server does not currently challenge every adult `create_link`
request with the PIN. Profile timezone and `get_time` use the same server
timezone.

Content types are `itv` (live TV), `vod` (movies), `series`, and `radio`.
Series listings expose episodes synchronized into `provider_series_episodes`;
when a selected series has not reached the background sync yet, its episodes
are fetched on demand. Ambiguous duplicate season/episode numbers are not
published. Radio categories use live provider channels and can be created or
imported from the normal category-management UI. MP3/AAC radio sources pass
through directly; other radio sources use the authenticated MP3 transcode path.

`create_link` enforces the requested module: `itv`, `radio`, and `series`
commands must target the same type; `vod` accepts movies plus the documented
series episode command only when both its positive season and `series` episode
number are present. `tv_archive` accepts only the opaque archive command emitted
for an authorized EPG row. Cross-module commands return `nothing_to_play`.

Epoch-based internal catch-up links are accepted only for completed EPG
programmes inside the configured archive window. Formatted Xtream timeshift
starts remain supported.

Bulk EPG clamps `period` to 168 hours. The response window determines a maximum
of four programme rows per hour, capped at 500 rows per channel, with a global
20,000-row cap. Channel keys remain present with empty arrays. EPG channel IDs
and programme start times provide deterministic selection order; once the
global cap is reached, later rows remain omitted and a counts-only warning is
logged. The application has no existing global HTTP compression middleware, so
this PR adds no isolated compression dependency; bounded database iteration and
response limits are used instead.

Archived EPG rows are marked only when the channel has catch-up enabled and the
programme remains inside its configured archive window. Their opaque
`/media/<id>.mpg` commands are resolved with
`type=tv_archive&action=create_link` into the normal token-authenticated
timeshift proxy after the exact EPG interval is revalidated.
`type=epg&action=get_simple_data_table` returns the authorized channel's
date-filtered programmes in deterministic 10-row pages for archive-capable
clients. Click-through archive playback has been validated with OTT Navigator
1.7.4.1 on Android 16 through the authenticated IPTV-Manager timeshift proxy.

Generated links for all content reuse the normal token-authenticated live,
movie, series, or timeshift proxies, so user channel grants, region locks,
session revocation, and connection limits remain in force. Device management is
admin-only. A hardware-specific MAG portal UI is not included.

## HDHomeRun Emulation

- `GET /hdhr/:token/discover.json`
- `GET /hdhr/:token/device.xml`
- `GET /hdhr/:token/lineup_status.json`
- `GET /hdhr/:token/lineup.json`
- `GET /hdhr/:token/auto/v:channelId`
- `GET /hdhr/:token/stream/:stream_id.ts`
- `GET /hdhr/:token/movie/:stream_id.:ext`
