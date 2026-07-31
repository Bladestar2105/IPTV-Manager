import crypto from 'crypto';
import db from '../database/db.js';
import { getEpgPrograms } from '../services/epgService.js';
import { invalidateUserTokens } from '../services/authService.js';
import { isIpAllowedForUser } from '../services/geoIpService.js';
import { getBaseUrl, getCookie } from '../utils/helpers.js';
import { expiryEpoch, normalizeMac } from '../utils/stalker.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const ACTIVITY_UPDATE_INTERVAL_SECONDS = 60;
const PAGE_SIZE = 100;
const SERVER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function value(params, name) {
  const raw = params[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function getParams(req) {
  return { ...req.query, ...(req.body || {}) };
}

function getRequestMac(req, params) {
  return normalizeMac(value(params, 'mac') || getCookie(req, 'mac'));
}

function getRequestToken(req, params) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(value(params, 'token') || value(params, 'access_token') || '').trim();
}

function authorizationFailed(res) {
  return res.status(200).type('text/plain').send('Authorization failed.');
}

function js(res, payload) {
  res.set('Cache-Control', 'no-store');
  return res.json({ js: payload });
}

function findDevice(mac) {
  if (!mac) return null;
  return db.prepare(`
    SELECT sd.*, u.username, u.expiry_date, u.allowed_countries, u.is_active
    FROM stalker_devices sd
    JOIN users u ON u.id = sd.user_id
    WHERE sd.mac = ? COLLATE NOCASE AND sd.enabled = 1 AND u.is_active = 1
  `).get(mac);
}

function createSession(req, params, res) {
  const mac = getRequestMac(req, params);
  const device = findDevice(mac);
  const now = Math.floor(Date.now() / 1000);
  const userExpiry = expiryEpoch(device?.expiry_date);

  if (!device || (userExpiry && userExpiry <= now) || !isIpAllowedForUser(req.ip, device)) {
    return authorizationFailed(res);
  }

  const expiresAt = userExpiry
    ? Math.min(now + SESSION_TTL_SECONDS, userExpiry)
    : now + SESSION_TTL_SECONDS;
  const token = crypto.randomBytes(32).toString('hex');
  const model = String(value(params, 'stb_type') || device.model || '').trim().slice(0, 100) || null;
  const serialNumber = String(value(params, 'sn') || device.serial_number || '').trim().slice(0, 100) || null;
  const deviceUid = String(value(params, 'device_id') || value(params, 'device_id2') || device.device_uid || '').trim().slice(0, 100) || null;

  db.transaction(() => {
    db.prepare('DELETE FROM stalker_sessions WHERE device_id = ? OR expires_at <= ?').run(device.id, now);
    db.prepare(`
      INSERT INTO stalker_sessions (token, device_id, user_id, created_at, expires_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, device.id, device.user_id, now, expiresAt, now);
    db.prepare(`
      UPDATE stalker_devices
      SET serial_number = ?, device_uid = ?, model = ?, last_ip = ?, last_seen = ?
      WHERE id = ?
    `).run(serialNumber, deviceUid, model, req.ip || null, now, device.id);
  })();
  invalidateUserTokens(device.user_id);

  return js(res, {
    token,
    random: crypto.randomBytes(20).toString('hex')
  });
}

function getSession(req, params) {
  const token = getRequestToken(req, params);
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(`
    SELECT ss.token, ss.expires_at, ss.last_seen AS session_last_seen,
           sd.id AS device_id, sd.mac, sd.model, sd.serial_number, sd.device_uid,
           sd.last_seen AS device_last_seen,
           u.id AS user_id, u.username, u.expiry_date, u.allowed_countries, u.is_active
    FROM stalker_sessions ss
    JOIN stalker_devices sd ON sd.id = ss.device_id
    JOIN users u ON u.id = ss.user_id
    WHERE ss.token = ? AND ss.expires_at > ? AND sd.enabled = 1 AND u.is_active = 1
  `).get(token, now);

  if (!session) return null;
  const requestedMac = getRequestMac(req, params);
  if (requestedMac && requestedMac !== session.mac) return null;
  const userExpiry = expiryEpoch(session.expiry_date);
  if ((userExpiry && userExpiry <= now) || !isIpAllowedForUser(req.ip, session)) return null;

  const oldestActivity = Math.min(
    Number(session.session_last_seen) || 0,
    Number(session.device_last_seen) || 0
  );
  if (now - oldestActivity >= ACTIVITY_UPDATE_INTERVAL_SECONDS) {
    db.transaction(() => {
      db.prepare('UPDATE stalker_sessions SET last_seen = ? WHERE token = ?').run(now, token);
      db.prepare('UPDATE stalker_devices SET last_ip = ?, last_seen = ? WHERE id = ?').run(req.ip || null, now, session.device_id);
    })();
  }
  return session;
}

function profile(session) {
  return {
    id: String(session.user_id),
    name: session.username,
    login: session.username,
    ls: String(session.user_id),
    mac: session.mac,
    status: 1,
    auth_access: 0,
    stb_type: session.model || '',
    sn: session.serial_number || '',
    device_id: session.device_uid || '',
    hd: 1,
    tv_quality: 'high',
    additional_services_on: '1',
    parent_password: '0000',
    settings_password: '0000',
    timezone: SERVER_TIMEZONE,
    default_timezone: SERVER_TIMEZONE,
    show_tv_channel_logo: 1,
    enable_buffering_indication: 1,
    expires_at: session.expires_at
  };
}

function getGenres(session) {
  const categories = db.prepare(`
    SELECT cat.id, cat.name, cat.is_adult
    FROM user_categories cat
    WHERE cat.user_id = ? AND cat.type = 'live'
      AND EXISTS (
        SELECT 1
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE uc.user_category_id = cat.id AND pc.stream_type = 'live'
      )
    ORDER BY cat.sort_order, cat.name
  `).all(session.user_id);

  return [
    { id: '*', title: 'All', alias: 'all', censored: 0 },
    ...categories.map(category => ({
      id: String(category.id),
      title: category.name,
      alias: String(category.id),
      censored: category.is_adult ? 1 : 0
    }))
  ];
}

function getOrderedList(session, params, paginated = true) {
  const requestedGenre = Number(value(params, 'genre'));
  const genreId = Number.isSafeInteger(requestedGenre) && requestedGenre > 0 ? requestedGenre : null;
  const requestedPage = Number(value(params, 'p'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage >= 0
    ? Math.min(requestedPage, 1_000_000)
    : 0;
  const offset = paginated ? page * PAGE_SIZE : 0;
  const whereGenre = genreId ? ' AND cat.id = ?' : '';
  const bindings = genreId ? [session.user_id, genreId] : [session.user_id];

  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    WHERE cat.user_id = ? AND cat.type = 'live' AND pc.stream_type = 'live'
    ${whereGenre}
  `).get(...bindings).count;

  const channels = db.prepare(`
    SELECT uc.id, uc.custom_name, uc.sort_order,
           cat.id AS category_id, cat.is_adult,
           pc.name, pc.logo, pc.tv_archive, pc.tv_archive_duration
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    WHERE cat.user_id = ? AND cat.type = 'live' AND pc.stream_type = 'live'
    ${whereGenre}
    ORDER BY cat.sort_order, uc.sort_order, pc.original_sort_order, pc.name
    ${paginated ? 'LIMIT ? OFFSET ?' : ''}
  `).all(...bindings, ...(paginated ? [PAGE_SIZE, offset] : []));

  return {
    total_items: String(total),
    max_page_items: paginated ? PAGE_SIZE : total,
    selected_item: 0,
    cur_page: paginated ? page : 0,
    data: channels.map((channel, index) => ({
      id: String(channel.id),
      name: channel.custom_name || channel.name,
      number: String(offset + index + 1),
      tv_genre_id: String(channel.category_id),
      logo: channel.logo || '',
      cmd: `ffmpeg http://localhost/ch/${channel.id}_`,
      censored: channel.is_adult ? 1 : 0,
      use_http_tmp_link: 1,
      use_load_balancing: 0,
      enable_tv_archive: channel.tv_archive ? 1 : 0,
      allow_tv_archive: channel.tv_archive ? 1 : 0,
      tv_archive_duration: Number(channel.tv_archive_duration) || 0,
      open: 1,
      fav: 0
    }))
  };
}

function getShortEpg(session, params) {
  const channelId = Number(value(params, 'ch_id') || value(params, 'stream_id'));
  const limit = Math.min(Math.max(Number(value(params, 'size') || value(params, 'limit')) || 5, 1), 50);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return [];

  const channel = db.prepare(`
    SELECT pc.epg_channel_id, map.epg_channel_id AS manual_epg_id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = 'live' AND pc.stream_type = 'live'
  `).get(channelId, session.user_id);

  const epgId = channel?.manual_epg_id || channel?.epg_channel_id;
  if (!epgId) return [];

  const result = [];
  for (const program of getEpgPrograms(epgId, limit)) {
    result.push({
      id: String(program.start),
      ch_id: String(channelId),
      time: program.start_fmt,
      time_to: program.stop_fmt,
      name: program.title || '',
      descr: program.desc || '',
      start_timestamp: Number(program.start),
      stop_timestamp: Number(program.stop),
      duration: Math.max(Number(program.stop) - Number(program.start), 0)
    });
  }
  return result;
}

function createLink(req, session, params) {
  const command = String(value(params, 'cmd') || '');
  const match = command.match(/\/ch\/(\d+)/);
  const parsedChannelId = match ? Number(match[1]) : 0;
  const channelId = Number.isSafeInteger(parsedChannelId) && parsedChannelId > 0 ? parsedChannelId : 0;

  const channel = channelId ? db.prepare(`
    SELECT uc.id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = 'live' AND pc.stream_type = 'live'
  `).get(channelId, session.user_id) : null;

  if (!channel) {
    return { id: 0, cmd: '', streamer_id: 0, link_id: 0, load: 0, error: 'nothing_to_play' };
  }

  const url = `${getBaseUrl(req)}/live/token/auth/${channel.id}.ts?token=${encodeURIComponent(session.token)}`;
  return {
    id: String(channel.id),
    cmd: `ffmpeg ${url}`,
    streamer_id: 0,
    link_id: String(channel.id),
    load: 0,
    error: ''
  };
}

export function portal(req, res) {
  const params = getParams(req);
  const type = String(value(params, 'type') || '').toLowerCase();
  const action = String(value(params, 'action') || '').toLowerCase();

  if (type === 'stb' && action === 'handshake') {
    return createSession(req, params, res);
  }

  const session = getSession(req, params);
  if (!session) return authorizationFailed(res);

  if (type === 'stb') {
    if (action === 'get_profile') return js(res, profile(session));
    if (action === 'get_modules') {
      return js(res, {
        all_modules: ['tv'],
        switchable_modules: [],
        disabled_modules: [],
        restricted_modules: [],
        template: 'default'
      });
    }
    if (action === 'get_localization') return js(res, {});
    if (action === 'get_main_info') {
      return js(res, {
        phone: '',
        tariff_plan: '',
        account_balance: '',
        end_date: session.expiry_date || ''
      });
    }
    if (action === 'get_time') {
      return js(res, { time: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    }
  }

  if (type === 'itv') {
    if (action === 'get_genres') return js(res, getGenres(session));
    if (action === 'get_ordered_list') return js(res, getOrderedList(session, params));
    if (action === 'get_all_channels') return js(res, getOrderedList(session, params, false));
    if (action === 'get_short_epg') return js(res, getShortEpg(session, params));
    if (action === 'create_link') return js(res, createLink(req, session, params));
  }

  return js(res, {});
}
