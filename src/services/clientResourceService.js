import db from '../database/db.js';
import epgDb from '../database/epgDb.js';
import crypto from 'node:crypto';
import { decrypt, encrypt, ENCRYPTION_KEY } from '../utils/crypto.js';
import { getBaseUrl } from '../utils/helpers.js';
import { expiryEpoch } from '../utils/stalker.js';
import { getXtreamUser } from './authService.js';
import { isIpAllowedForUser } from './geoIpService.js';
import { getEpgLogo, resolveEpgLogoUrl } from './logoResolver.js';
import { createUpstreamContext } from '../utils/clientCookies.js';
import { directMetadataUrl } from '../utils/clientResourcePolicy.js';
import { normalizeInlineClearKey } from '../utils/clientClearKey.js';
import { createClientPlaybackId, currentPlaybackCookieJar } from './clientPlaybackContextService.js';
export { createClientPlaybackId } from './clientPlaybackContextService.js';

const PURPOSE = 'client-resource-v1';
const LICENSE_TTL = 7 * 86400;
let nextLicenseCleanup = 0;
const TEMPLATE = /\$(RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%0\d+d)?\$/g;
const secretFields = /^(?:headers|http_headers|authorization|cookie|password|provider_pass|provider_user|provider_url|username|access_token)$/i;
const sourceFields = /^(?:direct_source|stream_url|original_url|source_url|playback_url|play_url|stream_source|stream_link)$/i;
const imageFields = /(?:icon|logo|cover|poster|backdrop|screenshot|movie_image|image)/i;
const resourceFields = /(?:subtitle|caption|trailer)|(?:url|uri|href|src|path)$|^file$/i;
const licenseFields = /^(?:license_?(?:url|uri)|la_url)$/i;

function opaque(payload) {
  return encrypt(JSON.stringify(payload)).split(':').map(part => Buffer.from(part, 'hex').toString('base64url')).join('.');
}

function readGrant(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 65536 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(encoded)) return null;
  try {
    const raw = encoded.split('.').map(part => Buffer.from(part, 'base64url').toString('hex')).join(':');
    const payload = JSON.parse(decrypt(raw));
    return payload?.purpose === PURPOSE && Number.isSafeInteger(payload.uid) && ['image', 'resource', 'license'].includes(payload.kind) ? payload : null;
  } catch { return null; }
}

function context(req, user) {
  return {
    purpose: PURPOSE,
    uid: Number(user.id),
    version: Number(user.token_version) || 0,
    admin: !!user.is_admin,
    sourceToken: user.resource_token || (req.user ? null : req.query?.token || req.params?.token) || null,
  };
}

function httpUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\u0000]/.test(value)) return null;
  try {
    const parsed = new URL(value, base);
    return /^https?:$/.test(parsed.protocol) ? parsed : null;
  } catch { return null; }
}

function resourceUrl(req, payload, extension) {
  const query = [];
  if (payload.url) {
    payload.templates = [...new Map([payload.url, ...(payload.alternatives || [])].flatMap(url =>
      [...url.matchAll(TEMPLATE)].map(match => [match[0], { token: match[0], type: match[1] }]))).values()];
    payload.templates.forEach((item, index) => query.push(`tpl${index}=${item.token}`));
  }
  return `${getBaseUrl(req)}/api/proxy/resource/${opaque(payload)}/${extension}${query.length ? `?${query.join('&')}` : ''}`;
}

function normalizedGrant(payload) {
  const normalized = { ...payload, cookieJar: { ...payload.cookieJar, cookies: (payload.cookieJar?.cookies || []).map(cookie => {
    const copy = { ...cookie };
    delete copy.lastAccessed;
    if (copy.maxAge === undefined) delete copy.creation;
    return copy;
  }) } };
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(normalized));
}

export function createMediaLicenseIdentity(source, context) {
  const headers = Object.fromEntries(Object.entries(context.headers || {}).filter(([name]) => !/^(?:range|if-range)$/i.test(name)));
  return crypto.createHash('sha256').update(normalizedGrant({ source, ...context, headers })).digest('hex');
}

function compactLicenseUrl(req, payload) {
  const now = Math.floor(Date.now() / 1000);
  if (now >= nextLicenseCleanup) {
    db.prepare('DELETE FROM client_license_grants WHERE id IN (SELECT id FROM client_license_grants WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').run(now);
    nextLicenseCleanup = now + 60;
  }
  // A keyed fingerprint deduplicates repeated PSSH without exposing target guesses.
  // Range slices of the same entity must embed the same URL after credential rotation.
  const fingerprintPayload = payload.compactIdentity
    ? Object.fromEntries(['purpose', 'kind', 'uid', 'version', 'admin', 'sourceToken', 'channelId', 'providerId', 'url', 'headerOrigin', 'compactIdentity'].map(key => [key, payload[key]]))
    : payload;
  const fingerprint = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex')).update(normalizedGrant(fingerprintPayload)).digest('hex');
  let row = db.prepare('SELECT id, expires_at, envelope FROM client_license_grants WHERE fingerprint = ?').get(fingerprint);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO client_license_grants (id, fingerprint, envelope, expires_at) VALUES (?, ?, ?, ?)')
      .run(crypto.randomBytes(16).toString('base64url'), fingerprint, opaque(payload), now + LICENSE_TTL);
    row = db.prepare('SELECT id, expires_at, envelope FROM client_license_grants WHERE fingerprint = ?').get(fingerprint);
  }
  // Avoid a write for every repeated initialization/rotation record.
  const current = readGrant(row.envelope);
  if (!current || normalizedGrant(current) !== normalizedGrant(payload)) {
    db.prepare('UPDATE client_license_grants SET envelope = ?, expires_at = MAX(expires_at, ?) WHERE id = ?').run(opaque(payload), now + LICENSE_TTL, row.id);
  } else if (row.expires_at < now + LICENSE_TTL - 3600) {
    db.prepare('UPDATE client_license_grants SET expires_at = MAX(expires_at, ?) WHERE id = ?').run(now + LICENSE_TTL, row.id);
  }
  return `${getBaseUrl(req)}/r/${row.id}`;
}

export async function resolveCompactLicenseResource(req) {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
  try {
    const row = db.prepare('SELECT envelope FROM client_license_grants WHERE id = ? AND expires_at > ?').get(id, Math.floor(Date.now() / 1000));
    if (!row || readGrant(row.envelope)?.kind !== 'license') return null;
    return await resolveClientResource({ params: { data: row.envelope }, query: {}, ip: req.ip, headers: req.headers });
  } catch { return null; }
}

// Grants name one resource, rather than exposing provider credentials or issuing
// a full-account bearer token just to let an IPTV client display an image.
export function createClientResourceUrl(req, user, url, options = {}) {
  const base = getBaseUrl(req);
  const parsed = httpUrl(url, options.baseUrl || base);
  if (!parsed) return '';
  // Host/forwarded-host are request-controlled and cannot prove that an URL is
  // Manager-owned. Preserve only an authenticated grant with its exact envelope.
  const match = parsed.pathname.match(/^\/api\/proxy\/resource\/([^/]+)\/([^/]+)$/);
  const existing = match && readGrant(match[1]);
  if (existing && existing.uid === Number(user.id) && existing.admin === !!user.is_admin && existing.version === (Number(user.token_version) || 0)) {
    const filename = existing.kind === 'image' ? 'image.png' : existing.kind === 'license' ? 'license' : 'resource';
    const parameters = (existing.templates || []).map((item, index) => `tpl${index}=${item.token}`).join('&');
    const search = parameters ? `?${parameters}` : '';
    if (match[2] === filename && parsed.search === search) {
      if (existing.kind === 'license' && options.compact) return compactLicenseUrl(req, existing);
      return `${base}${parsed.pathname}${search}`;
    }
  }
  if (!options.baseUrl && /^(?:\/)?logo\.png$/.test(url)) return `${base}/logo.png`;
  const kind = options.kind || 'image';
  if (!['image', 'resource', 'license'].includes(kind)) return '';
  if (options.alternatives && (!Array.isArray(options.alternatives) || options.alternatives.length > 63)) throw new Error('Too many resource alternatives');
  const upstreamContext = createUpstreamContext(options.headers || {}, options.headerOrigin || parsed.href, options.cookieJar, options.headerOrigin || parsed.href, true);
  if (kind !== 'license' && (kind === 'image' || options.allowDirectMetadata)) {
    const direct = directMetadataUrl(parsed.href, undefined, upstreamContext);
    if (direct) return direct;
  }
  const payload = {
    ...context(req, user), kind, url: parsed.href,
    ...(kind === 'resource' || options.playbackId ? { playbackId: options.playbackId || createClientPlaybackId() } : {}),
    ...upstreamContext,
    channelId: options.channelId || null,
    channelName: options.channelName || null,
    providerId: options.providerId || null,
    hlsVariables: options.hlsVariables || {},
    manifestKind: options.manifestKind || null,
    ...(options.alternatives?.length ? { alternatives: [...new Set(options.alternatives.map(value => {
      const candidate = httpUrl(value, options.baseUrl || base);
      if (!candidate) throw new Error('Invalid resource alternative');
      return candidate.href;
    }))].filter(value => value !== parsed.href) } : {}),
  };
  const explicitLicenseCookie = kind === 'license' && options.playbackId && new Headers(options.headers || {}).get('cookie');
  if (explicitLicenseCookie) {
    // Explicit license credentials must not overwrite the media session's cookie.
    payload.playbackId = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
      .update(JSON.stringify(['license-cookie-v1', options.playbackId, parsed.href, explicitLicenseCookie])).digest('base64url').slice(0, 22);
  }
  if (kind === 'license' && !payload.playbackId) {
    payload.playbackId = crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex'))
      .update(normalizedGrant(payload)).digest('base64url').slice(0, 22);
  }
  if (kind === 'license' && options.compact && typeof options.compactIdentity === 'string' && options.compactIdentity && payload.providerId && payload.channelId) {
    payload.compactIdentity = options.compactIdentity;
  }
  if (kind === 'license' && options.compact) return compactLicenseUrl(req, payload);
  return resourceUrl(req, payload, kind === 'image' ? 'image.png' : kind === 'license' ? 'license' : 'resource');
}

export function createChannelIconUrl(req, user, userChannelId, { providerId = null } = {}) {
  const channelId = Number(userChannelId);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return '';
  return resourceUrl(req, { ...context(req, user), kind: 'image', channelId, providerId, currentIcon: true }, 'image.png');
}

export function createEpgIconUrl(req, user, channel, { requireMappedChannel = false } = {}) {
  if (!['provider', 'custom'].includes(channel.source_type) || !Number.isSafeInteger(Number(channel.source_id)) || Number(channel.source_id) <= 0 || !channel.id) return '';
  return resourceUrl(req, {
    ...context(req, user), kind: 'image', epgChannelId: String(channel.id),
    epgSourceType: channel.source_type, epgSourceId: Number(channel.source_id), requireMappedChannel,
  }, 'image.png');
}

function shareAllowed(user, channelId) {
  if (!user.is_share_guest) return true;
  const now = Date.now() / 1000;
  if ((user.share_start && now < user.share_start) || (user.share_end && now > user.share_end)) return false;
  return !channelId || (user.allowed_channels || []).some(id => Number(id) === Number(channelId));
}

function representationComponent(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  let decoded = value;
  for (let depth = 0; depth <= 8; depth++) {
    if (/[\u0000-\u001f\u007f]/.test(decoded) || /(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(decoded)) return null;
    let next;
    try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break;
    if (depth === 8) return null;
    decoded = next;
  }
  return encodeURIComponent(value);
}

export async function resolveClientResource(req) {
  try {
    const payload = readGrant(req.params.data);
    if (!payload) return null;
    if (payload.channelId && !payload.providerId && !payload.currentIcon && !payload.epgChannelId) return null;

    const user = db.prepare(`SELECT * FROM ${payload.admin ? 'admin_users' : 'users'} WHERE id = ?`).get(payload.uid);
    const expires = expiryEpoch(user?.expiry_date);
    if (!user?.is_active || (Number(user.token_version) || 0) !== payload.version ||
        (expires && expires <= Date.now() / 1000) || !isIpAllowedForUser(req.ip, user)) return null;
    let authorizedUser = user;
    if (payload.sourceToken) {
      authorizedUser = await getXtreamUser({ params: {}, query: { token: payload.sourceToken }, ip: req.ip, headers: req.headers }, { fresh: true });
      if (!authorizedUser || Number(authorizedUser.id) !== payload.uid) return null;
    }
    if (!shareAllowed(authorizedUser, payload.channelId)) return null;
    if (payload.providerId && !payload.channelId) {
      const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(payload.providerId);
      if (!provider || (!payload.admin && Number(provider.user_id) !== Number(user.id))) return null;
    }

    let channel;
    if (payload.channelId) {
      channel = db.prepare(`
        SELECT pc.logo, pc.provider_id, pc.epg_channel_id, map.epg_channel_id AS manual_epg_id, p.use_mapped_epg_icon, p.url AS provider_url
        FROM authorized_user_channels uc
        JOIN user_categories cat ON cat.id = uc.user_category_id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        LEFT JOIN providers p ON p.id = pc.provider_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      `).get(payload.channelId, user.id);
      if (!channel) return null;
      if (payload.providerId) {
        // Use the playback pool rules, including explicit cross-owner grants.
        const { getChannel, getProviderCandidates } = await import('../controllers/streamControllerHelpers.js');
        const current = getChannel(payload.channelId, user.id);
        if (!current || !getProviderCandidates(user.id, current).some(provider => Number(provider.id) === Number(payload.providerId))) return null;
      }
    }
    let url = payload.url;
    if (payload.epgChannelId) {
      if (payload.kind !== 'image' || !['provider', 'custom'].includes(payload.epgSourceType)) return null;
      const sourceTable = payload.epgSourceType === 'provider' ? 'providers' : 'epg_sources';
      if (!db.prepare(`SELECT 1 FROM ${sourceTable} WHERE id = ?`).get(payload.epgSourceId)) return null;
      const epgChannel = epgDb.prepare('SELECT logo FROM epg_channels WHERE id = ? AND source_type = ? AND source_id = ?')
        .get(payload.epgChannelId, payload.epgSourceType, payload.epgSourceId);
      if (!epgChannel) return null;
      if (payload.requireMappedChannel) {
        const assignments = db.prepare(`
          SELECT uc.id FROM authorized_user_channels uc
          JOIN user_categories cat ON cat.id = uc.user_category_id
          JOIN provider_channels pc ON pc.id = uc.provider_channel_id
          LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
          WHERE cat.user_id = ? AND COALESCE(map.epg_channel_id, pc.epg_channel_id) = ?
        `).all(user.id, payload.epgChannelId);
        if (!assignments.some(assignment => shareAllowed(authorizedUser, assignment.id))) return null;
      }
      url = resolveEpgLogoUrl(epgChannel.logo, payload.epgSourceType, payload.epgSourceId);
    }
    if (payload.currentIcon) {
      const epgId = channel.manual_epg_id || channel.epg_channel_id;
      url = (channel.use_mapped_epg_icon && epgId && getEpgLogo(epgId, { absolute: true })) || channel.logo;
    }
    let alternatives = payload.alternatives || [];
    const originalAlternatives = alternatives;
    for (const [index, item] of (payload.templates || []).entries()) {
      const value = req.query[`tpl${index}`];
      const component = item.type === 'RepresentationID' ? representationComponent(value)
        : typeof value === 'string' && /^\d{1,32}$/.test(value) ? value : null;
      if (component === null) return null;
      url = url.replaceAll(item.token, () => component);
      alternatives = alternatives.map(value => value.replaceAll(item.token, () => component));
    }
    const parsed = httpUrl(url, payload.currentIcon ? channel.provider_url || getBaseUrl(req) : undefined);
    if (!parsed) return null;
    if (payload.templates?.length && parsed.origin !== httpUrl(payload.url)?.origin) return null;
    if (alternatives.some((value, index) => !httpUrl(value) || httpUrl(value).origin !== httpUrl(originalAlternatives[index])?.origin)) return null;
    if (payload.playbackId) payload.cookieJar = currentPlaybackCookieJar(payload);
    return {
      ...payload, url: parsed.href, ...(alternatives.length ? { alternatives } : {}),
      user: { ...authorizedUser, max_connections: user.max_connections },
      providerId: payload.currentIcon ? channel?.provider_id : payload.providerId,
    };
  } catch { return null; }
}

export function rewriteClientMetadata(req, user, value, key = '', options = {}) {
  if (Array.isArray(value)) return value.map(item => rewriteClientMetadata(req, user, item, key, options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([field]) => !secretFields.test(field))
      .map(([field, item]) => [field, sourceFields.test(field) ? '' : rewriteClientMetadata(req, user, item, field, options)]));
  }
  if (typeof value !== 'string') return value;
  if (/^license_key$/i.test(key)) {
    const inline = normalizeInlineClearKey(value);
    if (inline !== undefined) return inline;
  }
  const relative = options.baseUrl && value.trim() && !/^(?:[a-z][a-z\d+.-]*:|#)/i.test(value.trim()) &&
    (!/trailer/i.test(key) || /[./\\?#]/.test(value)) &&
    (imageFields.test(key) || resourceFields.test(key) || /^license_key$/i.test(key));
  if (/^license_key$/i.test(key) && (/^(?:https?:)?\/\//i.test(value) || relative)) {
    const [url, encodedHeaders, ...transforms] = value.split('|');
    let decoded;
    try { decoded = decodeURIComponent(transforms.join('|')); } catch { return ''; }
    if (/(?:https?|ftp|rtsp|rtmp):|\/\/|[\r\n\u0000]/i.test(decoded)) return '';
    const headers = Object.fromEntries(new URLSearchParams(encodedHeaders || ''));
    const local = createClientResourceUrl(req, user, url, { ...options, kind: 'license', headers, headerOrigin: httpUrl(url, options.baseUrl || getBaseUrl(req))?.href });
    return transforms.length ? `${local}||${transforms.join('|')}` : local;
  }
  if (/^(?:https?:)?\/\//i.test(value.trim()) || relative) {
    return createClientResourceUrl(req, user, value.trim(), { ...options, allowDirectMetadata: true, kind: imageFields.test(key) ? 'image' : licenseFields.test(key) ? 'license' : 'resource' });
  }
  if (/^(?:javascript|file|ftp|rtsp|rtmp):/i.test(value.trim())) return '';
  return value;
}
