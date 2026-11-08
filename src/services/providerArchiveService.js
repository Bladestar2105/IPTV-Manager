import db from '../database/db.js';
import epgDb from '../database/epgDb.js';
import { immediateTransaction } from '../database/sqliteWrites.js';
import { acquireLock } from './providerLockService.js';
import { discardBody, fetchSafe, readBodyWithLimit } from '../utils/network.js';
import { decrypt } from '../utils/crypto.js';
import { getArchiveDays, isArchiveProgram } from '../utils/archive.js';
import { isSupportedEpoch } from '../utils/timezone.js';
import { sanitizeClientMetadataText } from '../utils/clientResourcePolicy.js';

const inFlight = new Map();

function authorizedChannel(channelId, userId) {
  return db.prepare(`
    SELECT uc.id, pc.id AS provider_channel_id, pc.provider_id, pc.remote_stream_id,
      pc.name, pc.epg_channel_id, map.epg_channel_id AS manual_epg_id,
      pc.tv_archive, pc.tv_archive_duration, p.url, p.username, p.password
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    JOIN providers p ON p.id = pc.provider_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      AND cat.type = 'live' AND pc.stream_type = 'live'
  `).get(channelId, userId);
}

function decodeText(value) {
  if (typeof value !== 'string') return '';
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return Buffer.from(decoded).toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')
    ? decoded : value;
}

async function backfill(channel, channelId, userId, authorizeRequest) {
  const lock = acquireLock(`archive:${channel.provider_channel_id}`, 'archive', { ttlSeconds: 30 });
  if (!lock) return;
  try {
    const url = new URL(`${channel.url.replace(/\/+$/, '')}/player_api.php`);
    url.search = new URLSearchParams({ username: channel.username, password: decrypt(channel.password),
      action: 'get_simple_data_table', stream_id: String(channel.remote_stream_id) }).toString();
    const response = await fetchSafe(url.toString(), { timeout: 10000, maxDurationMs: 10000 });
    if (!response.ok) { discardBody(response); return; }
    const data = await readBodyWithLimit(response, { as: 'json', timeoutMs: 10000, maxBytes: 8 * 1024 * 1024 });
    if (!Array.isArray(data?.epg_listings)) return;

    const normalized = data.epg_listings.map(row => {
      const lang = decodeText(row?.lang);
      return {
        start: Number(row?.start_timestamp), stop: Number(row?.stop_timestamp ?? row?.end_timestamp),
        title: sanitizeClientMetadataText(decodeText(row?.title)), desc: sanitizeClientMetadataText(decodeText(row?.description)),
        lang: /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(lang) && lang.length <= 63 ? lang : '',
      };
    });
    if (!await authorizeRequest()) return;
    const current = authorizedChannel(channelId, userId);
    // A mapping, provider or grant changed during the request: the old response has no current provenance.
    if (!current || ['provider_channel_id', 'provider_id', 'remote_stream_id', 'epg_channel_id',
      'manual_epg_id', 'url', 'username', 'password'].some(key => current[key] !== channel[key])) return;
    const epgId = current.manual_epg_id || current.epg_channel_id;
    if (!epgId) return;
    const now = Math.floor(Date.now() / 1000);
    const programs = normalized.filter(program => isSupportedEpoch(program.start) && isSupportedEpoch(program.stop)
      && isArchiveProgram(current, program, now));
    if (!programs.length) return;

    immediateTransaction(epgDb, () => {
      // Keep custom-source rows and the local current/future schedule intact.
      epgDb.prepare(`INSERT OR IGNORE INTO epg_channels (id, name, logo, source_type, source_id, updated_at)
        VALUES (?, ?, '', 'provider', ?, ?)`).run(epgId, current.name, current.provider_id, now);
      const insert = epgDb.prepare(`INSERT OR IGNORE INTO epg_programs
        (channel_id, source_type, source_id, start, stop, title, desc, lang)
        SELECT ?, 'provider', ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM epg_programs WHERE channel_id = ? AND start = ?)`);
      for (const program of programs) {
        insert.run(epgId, current.provider_id, program.start, program.stop, program.title, program.desc, program.lang,
          epgId, program.start);
      }
    })();
  } catch {
    // Provider errors can contain credential-bearing URLs; keep the diagnostic local and identity-only.
    console.warn(`Provider archive lookup failed for channel ${channelId}; keeping local EPG`);
  } finally {
    lock.release(60);
  }
}

export async function refreshProviderArchive(channelId, userId, authorizeRequest) {
  const channel = authorizedChannel(channelId, userId);
  if (!channel) return false;
  if (!getArchiveDays(channel) || !(channel.manual_epg_id || channel.epg_channel_id)) return Boolean(await authorizeRequest());
  const key = channel.provider_channel_id;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = backfill(channel, channelId, userId, authorizeRequest);
    inFlight.set(key, pending);
  }
  try { await pending; }
  finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
  return Boolean(authorizedChannel(channelId, userId)) && Boolean(await authorizeRequest());
}
