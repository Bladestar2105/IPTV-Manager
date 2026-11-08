import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

const { fetchSafe, readBodyWithLimit } = vi.hoisted(() => ({ fetchSafe: vi.fn(), readBodyWithLimit: vi.fn() }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe, readBodyWithLimit }));

const dataDir = mkdtempSync(join(tmpdir(), 'iptv-archive-access-'));
process.env.DATA_DIR = dataDir;
const { default: db, initDb } = await import('../../src/database/db.js');
const { default: epgDb, initEpgDb } = await import('../../src/database/epgDb.js');
const { authCache, tokenCache } = await import('../../src/services/authService.js');
const { encrypt } = await import('../../src/utils/crypto.js');
const { playerApi } = await import('../../src/controllers/xtreamPlayerApiController.js');
const app = express();
app.get('/player_api.php', playerApi);

describe('archive lookup request authority', () => {
  let userId;
  let channelId;
  const credentials = { username: 'archive-reader', password: 'archive-password' };
  beforeAll(() => { initDb(true); initEpgDb(); });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    authCache.clear();
    tokenCache.clear();
    db.exec(`DELETE FROM shared_links; DELETE FROM temporary_tokens; DELETE FROM user_channels;
      DELETE FROM user_categories; DELETE FROM provider_channels; DELETE FROM providers;
      DELETE FROM users; DELETE FROM provider_locks;`);
    epgDb.exec('DELETE FROM epg_programs; DELETE FROM epg_channels;');
    userId = Number(db.prepare('INSERT INTO users (username, password, provider_access) VALUES (?, ?, 0)')
      .run(credentials.username, encrypt(credentials.password)).lastInsertRowid);
    const providerId = Number(db.prepare('INSERT INTO providers (name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?)')
      .run('Archive provider', 'https://provider.invalid', 'upstream-user', encrypt('upstream-secret'), userId).lastInsertRowid);
    const providerChannelId = Number(db.prepare(`INSERT INTO provider_channels
      (provider_id, remote_stream_id, name, stream_type, epg_channel_id, tv_archive, tv_archive_duration)
      VALUES (?, 789, 'News', 'live', 'archive-news', 1, 14)`).run(providerId).lastInsertRowid);
    const categoryId = Number(db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Live', 'live')").run(userId).lastInsertRowid);
    channelId = Number(db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (?, ?)')
      .run(categoryId, providerChannelId).lastInsertRowid);
    fetchSafe.mockResolvedValue({ ok: true });
  });
  afterAll(() => {
    vi.restoreAllMocks();
    db.close();
    epgDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(['deleted share', 'changed share', 'expired share', 'disabled user', 'revoked token version'])
    ('does not store or return history after a %s during the provider wait', async scenario => {
      const now = Math.floor(Date.now() / 1000);
      const token = scenario.includes('share') ? 'pending-share' : 'pending-token';
      if (scenario.includes('share')) {
        db.prepare('INSERT INTO shared_links (token, user_id, channels, end_time) VALUES (?, ?, ?, ?)')
          .run(token, userId, JSON.stringify([channelId]), now + 3600);
      } else {
        db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, now + 3600);
      }
      let entered;
      const reading = new Promise(resolve => { entered = resolve; });
      let resume;
      readBodyWithLimit.mockImplementation(() => {
        entered();
        return new Promise(resolve => { resume = resolve; });
      });
      const pending = request(app).get('/player_api.php')
        .query({ action: 'get_simple_data_table', stream_id: channelId, token }).then(response => response);
      await reading;
      if (scenario === 'deleted share') db.prepare('DELETE FROM shared_links WHERE token = ?').run(token);
      if (scenario === 'changed share') db.prepare("UPDATE shared_links SET channels = '[]' WHERE token = ?").run(token);
      if (scenario === 'expired share') db.prepare('UPDATE shared_links SET end_time = ? WHERE token = ?').run(now - 1, token);
      if (scenario === 'disabled user') db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
      if (scenario === 'revoked token version') db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
      resume({ epg_listings: [{ start_timestamp: now - 13 * 86400, stop_timestamp: now - 13 * 86400 + 3600,
        title: Buffer.from('Archive before revocation').toString('base64') }] });

      const response = await pending;

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ epg_listings: [] });
      expect(epgDb.prepare('SELECT COUNT(*) AS c FROM epg_programs').get().c).toBe(0);
    });

  it('keeps archive access for an authorized normal owner without provider management access', async () => {
    const now = Math.floor(Date.now() / 1000);
    readBodyWithLimit.mockResolvedValue({ epg_listings: [{ start_timestamp: now - 13 * 86400,
      stop_timestamp: now - 13 * 86400 + 3600, title: Buffer.from('Available archive').toString('base64') }] });

    const response = await request(app).get('/player_api.php').query({ ...credentials,
      action: 'get_simple_data_table', stream_id: channelId });

    expect(response.status).toBe(200);
    expect(response.body.epg_listings).toEqual([expect.objectContaining({ has_archive: 1 })]);
    expect(epgDb.prepare('SELECT title FROM epg_programs').get().title).toBe('Available archive');
  });
});
