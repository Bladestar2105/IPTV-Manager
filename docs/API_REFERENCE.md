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

## Providers

- `GET /api/providers`
- `POST /api/providers`
- `PUT /api/providers/:id`
- `DELETE /api/providers/:id`
- `POST /api/providers/:id/sync`
- `GET /api/providers/:id/channels`
- `GET /api/providers/:id/categories`
- `POST /api/providers/:providerId/import-category`
- `POST /api/providers/:providerId/import-categories`

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
- `POST /api/mapping/reset`
- `POST /api/mapping/suggest`
- `POST /api/mapping/auto`

`GET /api/epg/schedule` is scoped to the authenticated user's visible channels
and, for share guests, to the share's allowed channel list. The web player uses
this endpoint for timeline data after rendering the channel list.

## User Backups

- `GET /api/users/:userId/backups`
- `POST /api/users/:userId/backups`
- `POST /api/users/:userId/backups/:id/restore`
- `DELETE /api/users/:userId/backups/:id`

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

## Proxy

- `GET /api/proxy/image`
- `DELETE /api/proxy/picons`

## Xtream and Player Compatibility

- `GET /cpp`
- `GET /player_api.php`
- `GET /get.php`
- `GET /xmltv.php`
- `GET /api/player/playlist`
- `GET /api/player/channels.json`

## Stream Proxy

- `GET /live/mpd/:username/:password/:stream_id/*`
- `GET /live/:username/:password/:stream_id.ts`
- `GET /live/:username/:password/:stream_id.m3u8`
- `GET /live/:username/:password/:stream_id.mp4`
- `GET /live/segment/:username/:password/seg.ts`
- `GET /live/segment/:username/:password/seg.key`
- `GET /movie/:username/:password/:stream_id.:ext`
- `GET /series/:username/:password/:episode_id.:ext`
- `GET /timeshift/:username/:password/:duration/:start/:stream_id.ts`
- `GET /timeshift/:username/:password/:duration/:start/:stream_id.m3u8`
- `GET /live/mpd/token/auth/:stream_id/*`
- `GET /live/token/auth/:stream_id.ts`
- `GET /live/token/auth/:stream_id.m3u8`
- `GET /live/token/auth/:stream_id.mp4`
- `GET /movie/token/auth/:stream_id.:ext`
- `GET /series/token/auth/:episode_id.:ext`
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
