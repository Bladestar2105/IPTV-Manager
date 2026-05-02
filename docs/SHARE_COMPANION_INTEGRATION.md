# Share Integration for Companion Apps (Xtream + M3U + EPG)

This guide explains how external clients (for example, companion apps) can integrate **share links** safely and completely, including **metadata** and **EPG** support.

## Goal

A share should work without regular user credentials while still providing:

- Live/VOD/Series streaming
- metadata endpoints
- EPG/XMLTV output
- strict time limits and channel restrictions

## Key Concepts

- Share links are exposed via slug URLs:  
  `https://<host>/share/<slug>`
- The short link redirects to `player.html?token=<share_token>`.
- For companion apps, the **token** is the primary authentication mechanism.

## Recommended App Flow

1. Accept a **share URL** (e.g. deep link or QR code).
2. Follow the redirect and extract `token` from the destination URL.
3. Use endpoints with `?token=<share_token>`:

### Xtream API (metadata)

- `GET /player_api.php?token=<share_token>`
- `GET /player_api.php?token=<share_token>&action=get_live_categories`
- `GET /player_api.php?token=<share_token>&action=get_live_streams`
- `GET /player_api.php?token=<share_token>&action=get_vod_categories`
- `GET /player_api.php?token=<share_token>&action=get_vod_streams`
- `GET /player_api.php?token=<share_token>&action=get_series_categories`
- `GET /player_api.php?token=<share_token>&action=get_series`
- Optional details:
  - `...&action=get_vod_info&vod_id=<id>`
  - `...&action=get_series_info&series_id=<id>`
  - `...&action=get_short_epg&stream_id=<id>&limit=<n>`
  - `...&action=get_epg_batch&stream_ids=<id,id>&date=<YYYY-MM-DD>`

When calling `GET /player_api.php?token=<share_token>` the `user_info` object includes share validity metadata for share guests:

- `valid_from`: UNIX timestamp (seconds) from when the share becomes valid, or `null`.
- `valid_until`: UNIX timestamp (seconds) when the share expires, or `null`.
- `is_valid_now`: `1` if currently valid, otherwise `0`.

Companion clients should poll this endpoint every 5 minutes to detect window updates (e.g. changed start/end times) and react without a full re-import.

For faster guide loading, companion clients can request Xtream EPG in batches. The
batch response is keyed by stream ID and each value contains the standard
`epg_listings` array. `date` selects a UTC day and only channels visible to the
authenticated user or share token are returned.

### M3U + EPG

- Playlist: `GET /get.php?token=<share_token>&type=m3u_plus`
- XMLTV: `GET /xmltv.php?token=<share_token>`

> Share playlists emit token-auth stream URLs  
> (`/live/token/auth/...?...token=<share_token>`).

## Expiry and Access Limits

- Shares can be time-limited (`start_time`, `end_time`).
- Only channels included in the share are returned in Xtream/M3U/EPG responses.
- Expired shares return no usable data (`403` or `auth:0`, depending on the endpoint).

## Implementation Tips for App Developers

- Store tokens securely (never log raw tokens; avoid unencrypted persistence).
- On HTTP 401/403, discard the token and prompt the user to re-open or re-import the share URL.
- Cache EPG/metadata with a short TTL (e.g. 5–15 minutes), because shares can be revoked or expire.
- For validity state, prefer a 5-minute `player_api.php` check and compare `valid_from`/`valid_until` to previously cached values.
