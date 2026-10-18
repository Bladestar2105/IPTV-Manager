import crypto from 'node:crypto';
import db from '../database/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';

const TTL = 7 * 86400;
let nextCleanup = 0;
const scope = resource => JSON.stringify(['uid', 'admin', 'version', 'sourceToken', 'channelId', 'providerId'].map(key => resource[key] ?? null));
const cookieKey = cookie => JSON.stringify([cookie.domain, cookie.path, cookie.key]);
const comparable = cookie => {
  if (!cookie) return null;
  const copy = { ...cookie };
  delete copy.lastAccessed;
  if (copy.maxAge === undefined) delete copy.creation;
  return JSON.stringify(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b))));
};

export const createClientPlaybackId = () => crypto.randomBytes(16).toString('base64url');

function readContext(resource, now) {
  if (!/^[\w-]{22}$/.test(resource.playbackId || '')) return null;
  const row = db.prepare('SELECT envelope FROM client_playback_contexts WHERE id = ? AND expires_at > ?').get(resource.playbackId, now);
  if (!row?.envelope) return null;
  const saved = JSON.parse(decrypt(row.envelope));
  if (saved.scope !== scope(resource)) throw new Error('Playback context scope mismatch');
  return saved;
}

// Called only after the grant's current user/channel/provider checks succeed.
export function currentPlaybackCookieJar(resource) {
  const saved = readContext(resource, Math.floor(Date.now() / 1000));
  if (!saved) return resource.cookieJar;
  const cookies = new Map((saved.cookieJar?.cookies || []).map(cookie => [cookieKey(cookie), cookie]));
  const deleted = new Set(saved.deleted || []);
  for (const cookie of resource.cookieJar?.cookies || []) {
    const key = cookieKey(cookie);
    if (!cookies.has(key) && !deleted.has(key)) cookies.set(key, cookie);
  }
  return { ...saved.cookieJar, cookies: [...cookies.values()] };
}

export function persistPlaybackCookies(resource, before, after) {
  if (!resource.playbackId) return after;
  const previous = new Map((before?.cookies || []).map(cookie => [cookieKey(cookie), cookie]));
  const incoming = new Map((after?.cookies || []).map(cookie => [cookieKey(cookie), cookie]));
  const changed = [...new Set([...previous.keys(), ...incoming.keys()])]
    .filter(key => comparable(previous.get(key)) !== comparable(incoming.get(key)));
  if (!changed.length) return after;
  const now = Math.floor(Date.now() / 1000);
  return db.transaction(() => {
    if (now >= nextCleanup) {
      db.prepare('DELETE FROM client_playback_contexts WHERE id IN (SELECT id FROM client_playback_contexts WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').run(now);
      nextCleanup = now + 60;
    }
    const saved = readContext(resource, now);
    const latest = saved?.cookieJar || before || after;
    const deleted = new Set(saved?.deleted || []);
    const merged = new Map((latest?.cookies || []).map(cookie => [cookieKey(cookie), cookie]));
    for (const key of changed) {
      if (incoming.has(key)) { merged.set(key, incoming.get(key)); deleted.delete(key); }
      else if (comparable(merged.get(key)) === comparable(previous.get(key))) { merged.delete(key); deleted.add(key); }
    }
    const cookieJar = { ...after, cookies: [...merged.values()] };
    db.prepare('INSERT INTO client_playback_contexts(id, envelope, expires_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope, expires_at=excluded.expires_at')
      .run(resource.playbackId, encrypt(JSON.stringify({ scope: scope(resource), cookieJar, deleted: [...deleted] })), now + TTL);
    return cookieJar;
  }).immediate();
}
