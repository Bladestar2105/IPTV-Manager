import db from '../database/db.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { getBaseUrl } from '../utils/helpers.js';
import { expiryEpoch } from '../utils/stalker.js';
import { getXtreamUser } from './authService.js';
import { isIpAllowedForUser } from './geoIpService.js';
import { getEpgLogo } from './logoResolver.js';
import { createUpstreamContext } from '../utils/clientCookies.js';

const PURPOSE = 'client-resource-v1';
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
    sourceToken: user.resource_token || req.query?.token || req.params?.token || null,
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
    payload.templates = [...payload.url.matchAll(TEMPLATE)].map(match => ({ token: match[0], type: match[1] }));
    payload.templates.forEach((item, index) => query.push(`tpl${index}=${item.token}`));
  }
  return `${getBaseUrl(req)}/api/proxy/resource/${opaque(payload)}/${extension}${query.length ? `?${query.join('&')}` : ''}`;
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
    if (match[2] === filename && parsed.search === search) return `${base}${parsed.pathname}${search}`;
  }
  if (!options.baseUrl && /^(?:\/)?logo\.png$/.test(url)) return `${base}/logo.png`;
  const kind = options.kind || 'image';
  if (!['image', 'resource', 'license'].includes(kind)) return '';
  return resourceUrl(req, {
    ...context(req, user), kind, url: parsed.href,
    ...createUpstreamContext(options.headers || {}, options.headerOrigin || parsed.href, options.cookieJar, options.headerOrigin || parsed.href, true),
    channelId: options.channelId || null,
    channelName: options.channelName || null,
    providerId: options.providerId || null,
    hlsVariables: options.hlsVariables || {},
    manifestKind: options.manifestKind || null,
  }, kind === 'image' ? 'image.png' : kind === 'license' ? 'license' : 'resource');
}

export function createChannelIconUrl(req, user, userChannelId) {
  const channelId = Number(userChannelId);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return '';
  return resourceUrl(req, { ...context(req, user), kind: 'image', channelId, currentIcon: true }, 'image.png');
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
    }
    let url = payload.url;
    if (payload.currentIcon) {
      const epgId = channel.manual_epg_id || channel.epg_channel_id;
      url = (channel.use_mapped_epg_icon && epgId && getEpgLogo(epgId, { absolute: true })) || channel.logo;
    }
    for (const [index, item] of (payload.templates || []).entries()) {
      const value = req.query[`tpl${index}`];
      const component = item.type === 'RepresentationID' ? representationComponent(value)
        : typeof value === 'string' && /^\d{1,32}$/.test(value) ? value : null;
      if (component === null) return null;
      url = url.replace(item.token, () => component);
    }
    const parsed = httpUrl(url, payload.currentIcon ? channel.provider_url || getBaseUrl(req) : undefined);
    if (!parsed) return null;
    if (payload.templates?.length && parsed.origin !== httpUrl(payload.url)?.origin) return null;
    return {
      ...payload, url: parsed.href,
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
  if (/trailer/i.test(key)) {
    const youtube = httpUrl(value, options.baseUrl || getBaseUrl(req));
    if (youtube && /^(?:(?:[a-z\d-]+\.)*youtube(?:-nocookie)?\.com|(?:www\.)?youtu\.be)$/.test(youtube.hostname)) {
      youtube.username = ''; youtube.password = '';
      return youtube.href;
    }
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
    return createClientResourceUrl(req, user, value.trim(), { ...options, kind: imageFields.test(key) ? 'image' : licenseFields.test(key) ? 'license' : 'resource' });
  }
  if (/^(?:javascript|file|ftp|rtsp|rtmp):/i.test(value.trim())) return '';
  return value;
}
