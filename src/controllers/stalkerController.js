import crypto from 'crypto';
import db from '../database/db.js';
import { invalidateUserTokens } from '../services/authService.js';
import { isIpAllowedForUser } from '../services/geoIpService.js';
import { getCookie } from '../utils/helpers.js';
import { decrypt } from '../utils/crypto.js';
import {
  expiryEpoch,
  formatStalkerDateTime,
  normalizeMac,
  STALKER_TIMEZONE
} from '../utils/stalker.js';
import { value, contentConfig, getCategories, getOrderedList, getSeriesSeasons } from './stalkerContentController.js';
import { getEpgInfo, getShortEpg, getSimpleEpg } from './stalkerEpgController.js';
import { createLink } from './stalkerLinkController.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const ACTIVITY_UPDATE_INTERVAL_SECONDS = 60;
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
  res.set('Cache-Control', 'no-store');
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
           sd.last_seen AS device_last_seen, sd.parental_pin_encrypted,
           u.id AS user_id, u.username, u.expiry_date, u.allowed_countries, u.is_active
    FROM stalker_sessions ss
    JOIN stalker_devices sd ON sd.id = ss.device_id AND sd.user_id = ss.user_id
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
  const parentalPin = decrypt(session.parental_pin_encrypted) || '';
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
    parent_password: /^\d{4,8}$/.test(parentalPin) ? parentalPin : '',
    settings_password: '',
    timezone: STALKER_TIMEZONE,
    default_timezone: STALKER_TIMEZONE,
    show_tv_channel_logo: 1,
    enable_buffering_indication: 1,
    expires_at: session.expires_at
  };
}

function mainInfo(session) {
  return {
    phone: '',
    tariff_plan: '',
    account_balance: '',
    end_date: session.expiry_date || '',
    account_info: {
      expire_date: session.expiry_date ? String(expiryEpoch(session.expiry_date) || '') : ''
    }
  };
}

export async function portal(req, res) {
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
    if (action === 'do_auth') return js(res, true);
    if (action === 'get_modules') {
      return js(res, {
        all_modules: ['tv', 'vclub', 'series', 'radio', 'tv_archive'],
        switchable_modules: [],
        disabled_modules: [],
        restricted_modules: [],
        template: 'default'
      });
    }
    if (action === 'get_localization') return js(res, {});
    if (action === 'get_main_info') return js(res, mainInfo(session));
    if (action === 'get_time') return js(res, { time: formatStalkerDateTime(new Date()) });
  }

  if (type === 'account_info' && action === 'get_main_info') {
    return js(res, mainInfo(session));
  }

  if (type === 'epg' && action === 'get_simple_data_table') {
    return js(res, getSimpleEpg(session, params));
  }

  const config = contentConfig(type);
  if (config) {
    if (['get_categories', 'get_genres', 'get_genres_itv', 'get_genres_vod'].includes(action)) {
      return js(res, getCategories(session, type));
    }
    if (action === 'get_ordered_list') {
      if (type === 'series' && value(params, 'movie_id')) {
        return js(res, await getSeriesSeasons(session, params));
      }
      return js(res, getOrderedList(session, params, type));
    }
    if (type === 'itv' && action === 'get_all_channels') {
      return js(res, getOrderedList(session, params, type, { paginated: false, excludeAdult: true }));
    }
    if (type === 'itv' && action === 'get_short_epg') return js(res, getShortEpg(session, params));
    if (type === 'itv' && action === 'get_epg_info') return js(res, getEpgInfo(session, params));
    if (action === 'create_link') return js(res, createLink(req, session, params, type));
  }

  if (type === 'tv_archive' && action === 'create_link') {
    return js(res, createLink(req, session, params, type));
  }

  return js(res, {});
}
