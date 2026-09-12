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

A normal-user password change updates the encrypted credentials used for client
links and revokes temporary player tokens and Stalker sessions in the same
transaction. It also clears the handling worker's credential and token caches.
Admin password changes affect only the administrator account, even when a normal
user has the same numeric ID.

## Optional AI assistance

All `/api/ai/*` routes require the current Web UI JWT in an
`Authorization: Bearer ...` header. Query, player, Stalker and share tokens
cannot authorize AI management. Mutations require same-origin browser requests
and JSON bodies (DELETE does not require a body). Responses are `no-store`.
The origin check respects `TRUST_PROXY` for forwarded host/protocol headers and
normalizes default ports. Forwarded headers from untrusted peers are ignored.
Concurrent connection edits check the stored version before writing. An edit
that loses this race returns `AI_CONNECTION_CHANGED` (409); reload before retrying.
See [setup, data boundaries and limits](AI_INTEGRATION.md).

| Method | Path | Purpose |
| --- | --- | --- |
| GET / PUT | `/api/ai/settings` | Read policy; administrators may change server enablement, own-connection permission, allowed users/functions and exact internal targets. |
| GET / PUT | `/api/ai/preferences` | Personal enablement, selected connection/model, language, timezone and automatic sync-summary opt-in. |
| GET / POST | `/api/ai/connections` | List usable connections or create an owned connection. |
| PUT / DELETE | `/api/ai/connections/:id` | Change/delete an owned connection. `api_key` is write-only; reads return `has_key` and `editable`. |
| POST | `/api/ai/connections/:id/discover` | Explicitly list models; no inference side effect. |
| POST | `/api/ai/connections/:id/test` | Test `model_ids` (one to three) with bounded synthetic chat/structured-output checks. |
| GET / POST | `/api/ai/jobs` | List up to 50 personal jobs or enqueue a feature request. |
| GET | `/api/ai/jobs/:id` | Read status and currently authorized result. |
| POST | `/api/ai/jobs/:id/cancel` | Best-effort cancellation without replaying a submitted request. |
| GET | `/api/ai/proposals/:id` | Read the stored before/after actions and dependencies. |
| POST | `/api/ai/proposals/:id/apply` | Apply selected `action_ids` and their dependencies with an `idempotency_key`. |
| GET | `/api/ai/changes/:id` | Read the authorized change record. |
| GET | `/api/ai/changes` | List up to 50 personal change records, including automatic rule applications; optional target `user_id`. |
| POST | `/api/ai/changes/:id/undo` | Conditionally restore only the recorded changed fields. |
| GET / POST | `/api/ai/rules` | List personal rules (`user_id` for administrators) or save a rule from an applied rename. |
| PUT / DELETE | `/api/ai/rules/:id` | Update/enable or delete a confirmed literal rule. Name and enabled-state updates survive history expiry; transformation changes require an available applied rename. |
| GET / DELETE | `/api/ai/conversations/:id` | Read structured search criteria or delete a conversation. |
| POST | `/api/ai/conversations/:id/messages` | Enqueue a search follow-up for the stored target user. |
| GET | `/api/ai/enrichments/:id` | Read the marked derived description and its current original. |
| GET | `/api/ai/channels/:id/programs` | Select an authorized EPG description for a provider channel; optional `user_id`/`timezone`, up to 100 programs in the next 24 hours, no model request. |
| GET | `/api/ai/usage` | Up to 200 recent request records, token counts and explicit unknown prices. |
| DELETE | `/api/ai/history` | Cancel personal jobs and clear jobs, conversations and enrichments; retain change records and rules. |

Connection fields include `name`, `base_url`, `api_key`, `shared`,
`allowed_user_ids`, `functions`, `enabled`, `model_id` and `token_parameter`.
Model selection requires a successful compatibility test. Shared-connection
users cannot edit, discover or test the owner's connection or retrieve its key.
Server policy defaults to disabled, and each user must opt in separately.

Proposal Apply and rule POST/PUT operations do not require an available model
connection or tested model. They make no provider request and retain current
account, Web UI, server/personal AI and feature authorization, ownership,
confirmation and source/conflict checks. Removing model setup does not prevent
an authorized user from confirming stored work or disabling a confirmed rule.
Inference and connection setup retain their connection/model permission checks.

Discovery returns model IDs with a bounded `candidate` hint (`text`, `other`,
`unknown`), without changing saved selection. A compatibility profile includes
`chat`, `structured`, `status`, `token_parameter`, `tested_at`, and a stable
`error_code` on failure. `unverified` does not mean incompatible. Tests accept
at most three models and three requests/model (128 output tokens/request);
one alternate token profile is allowed only after an explicit 400/422
unsupported-parameter rejection. Adopt an alternate profile by explicitly
setting the successfully tested `model_id` and matching `token_parameter`
together, then saving the personal selection. Other profile changes invalidate
compatibility. Authentication, permission and rate errors stop a test batch;
there is no automatic retry after a timeout or uncertain response.
Connections expose/store at most 100 capability profiles, retaining the current
connection and owner-personal selections plus recent tests. Evicted unselected
models require another explicit test. Retesting retained IDs only replaces
their profiles; unrelated profiles are evicted only for added IDs. Existing
oversized maps are capped in read responses and trimmed on their next normal
connection write.
Discovery and tests also perform bounded usage retention through the shared
request reservation: up to 100 inactive records older than 30 days per request.

Error categories are `AI_AUTH_FAILED`, `AI_PERMISSION_DENIED`, `AI_RATE_LIMIT`,
`AI_UNAVAILABLE`/`AI_TIMEOUT`, `AI_MODEL_UNAVAILABLE`,
`AI_CAPABILITY_UNSUPPORTED`, and `AI_TOKEN_PARAMETER_UNSUPPORTED`.
`AI_PAUSED` is reserved for repeated connection outages. Error bodies from the
upstream service are never returned.

Job `feature` is one of `list`, `cleanup`, `duplicates`, `epg`, `sync`,
`search`, `diagnose`, `text`. Common inputs are `prompt`, `language`, `timezone`,
`connection_id`, `user_id`, `category_id`, `channel_ids` (provider channel IDs),
`selected_ids` / `pinned_ids` (user assignment IDs), and `keep_first`.
Administrators must specify `user_id` for catalog work; omitting it is allowed
for aggregate diagnosis. A normal user can target only their own account.

For example, POST `/api/ai/jobs` with header `Idempotency-Key: cleanup-example-1`:

```json
{"feature":"cleanup","prompt":"Remove country prefixes from my channel names","language":"en","timezone":"Europe/Berlin","keep_first":10}
```

The response contains `id`, `status`, `feature` and `created_at`. Poll the job;
statuses are `queued`, `running`, `completed`, `failed`, `cancelled`. A completed
result may include `proposal_id`, `conversation_id`, `enrichment_id`, findings
and coverage. Reading a persisted result requires current account, Web UI and
AI feature access plus renewed source/ownership checks. It does not require
the former model connection, its sharing grant or a usable model. New and
in-flight jobs retain connection/model authorization. Fetch a proposal before
applying its chosen action IDs. Reusing a job idempotency key with changed input returns 409. Application does not
repeat inference. Stale sources, revoked rights and undo conflicts reject the
operation rather than overwriting current data.

For reordering, confirm all companion moves needed to keep the affected positions
unique within each category. Collisions reject the whole application with
`AI_REORDER_CONFLICT` (409). Undo also rejects occupied original positions.
Every stored action must belong to its declared feature's closed contract,
including unselected actions. Invalid legacy proposals fail before any mutation.
EPG mappings require `feature: "epg"`, current EPG permission and source evidence;
list/cleanup cannot carry them. Feature revocation after preview rejects Apply.

`full_list:true` raises the bounded page size. Follow `coverage.next_offset`
with `offset`; retain the reported partial status until the requested scope has
actually been examined. Search accepts `conversation_id` and explicit `filters`
patches with `query`, `type`, `genre`, `language`, `region`, `start`, `end`,
`max_duration` and `interests`. Null/empty values remove a filter. Program times
must have an explicit UTC offset; time windows are bounded to 14 days. Text
requests use `provider_channel_id`, `operation` and optionally an actual
`program` reference. Sync requests may select a recorded `snapshot_id`.
Sync `diff.counts` covers all currently authorized recorded changes. The
`diff.changes` preview is limited to 20 rows; `diff.preview.total`, `shown` and
`partial` describe its coverage. Revoking access to an off-preview change also
invalidates the bound result. Stored results using the former snapshot-only
evidence hash need a new analysis; requests are not automatically replayed.
Proposal responses may reference only existing channel, assignment and category
IDs supplied in that exact model request. This includes the bounded sync
candidates and EPG review cases; ownership alone does not admit an omitted ID.

Program search uses stable channel/source/start pagination. `truncated:true`
reports unexamined rows or a capped source catalog even when there are no
matches. Exact completed page/budget boundaries can return `truncated:false`.
Diagnosis accepts selected own editable hidden assignments without exposing
foreign/revoked entries. Findings carry `certainty: proven|possible|unknown`;
`channel_diagnostics` describes local assignment/export filters/EPG configuration,
and `local_user_connections` describes a timestamped local session/limit snapshot.
`explanation_unavailable:true` leaves those findings available if inference fails.
`coverage.diagnostic_entries_shown/total/partial` describes the bounded detail
preview. [Unimplemented diagnostic measurements](AI_INTEGRATION.md#local-diagnosis-coverage)
remain explicit unknowns; no diagnostic domain operation mutates state.

Errors contain a stable `code`/`error`, never upstream bodies or credentials.
Invalid input is 400, denied access 403, missing/expired private records 404,
stale/conflicting work 409, and rate/busy limits 429. Network/provider failures
have safe 5xx errors. Clients should translate the code and require explicit
retesting/selection after connection changes.

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
disabled by default and controls whether the normal user may view provider
connection details and the provider management box. Provider names/options and
the user's own provider catalog remain available for editing channel, movie,
series, and category-scoped EPG lists.

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

Normal users receive only their own provider names/options and provider catalog
rows. With `provider_access` disabled, `GET /api/providers` omits connection
details and the provider management box is hidden; own provider catalog and
category-import operations remain available for list editing. Restricted
catalog responses omit raw stream metadata, including original URLs, HTTP
headers, and DRM data.

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

Provider-scoped mapping reads require provider ownership and the
`provider_access` permission. Provider catalog reads used by a user's own list
editor do not require that setting.

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

Full-system imports retain each user's connection limit, expiry date, country
restrictions, and notes. Older exports without these fields use the existing
defaults.

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

M3U exports sanitize EPG identifiers as quoted attributes and keep DRM properties
on a single line. Quotes inside DRM values are preserved for JSON-based license
configuration.

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
