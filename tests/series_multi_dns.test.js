import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import { Response } from 'node-fetch';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  return { TEST_DB_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-series-multi-dns-')) };
});

vi.mock('../src/config/constants.js', async importOriginal => ({
  ...await importOriginal(),
  DATA_DIR: TEST_DB_DIR,
  CACHE_DIR: `${TEST_DB_DIR}/cache`,
  EPG_CACHE_DIR: `${TEST_DB_DIR}/cache/epg`,
  EPG_DB_PATH: `${TEST_DB_DIR}/epg.db`,
  BCRYPT_ROUNDS: 1,
}));
vi.mock('../src/utils/network.js', async importOriginal => ({
  ...await importOriginal(),
  fetchSafe: vi.fn(),
}));

import app from '../src/app.js';
import db, { initDb } from '../src/database/db.js';
import epgDb from '../src/database/epgDb.js';
import { encrypt } from '../src/utils/crypto.js';
import { fetchSafe } from '../src/utils/network.js';
import { tokenCache } from '../src/services/authService.js';

describe('series across two upstream DNS panels', () => {
  const credentials = { username: 'multi-dns-user', password: 'multi-dns-pass' };
  const assignments = [];

  beforeAll(() => {
    initDb(true);
    const userId = db.prepare(`
      INSERT INTO users (username, password, plain_password, is_active)
      VALUES (?, ?, ?, 1)
    `).run(credentials.username, encrypt(credentials.password), encrypt(credentials.password)).lastInsertRowid;
    const categoryId = db.prepare(`
      INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Series', 'series')
    `).run(userId).lastInsertRowid;

    for (const panel of ['first', 'second']) {
      const providerId = db.prepare(`
        INSERT INTO providers (user_id, name, url, username, password)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, panel, `https://${panel}.fixture.invalid`, `${panel}-user`, encrypt(`${panel}-pass`)).lastInsertRowid;
      const providerChannelId = db.prepare(`
        INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type)
        VALUES (?, 55, ?, 'series')
      `).run(providerId, `${panel} series`).lastInsertRowid;
      assignments.push(Number(db.prepare(`
        INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (?, ?)
      `).run(categoryId, providerChannelId).lastInsertRowid));
    }

    fetchSafe.mockImplementation(async value => {
      const url = new URL(value);
      const panel = url.hostname.split('.')[0];
      if (!['first', 'second'].includes(panel)) throw new Error('Unexpected upstream');
      if (url.pathname === '/player_api.php') {
        expect(url.searchParams.get('username')).toBe(`${panel}-user`);
        expect(url.searchParams.get('password')).toBe(`${panel}-pass`);
        expect(url.searchParams.get('series_id')).toBe('55');
        return new Response(JSON.stringify({
          info: { name: `${panel} series` },
          episodes: { 1: [{
            id: 123,
            season: 1,
            episode_num: 1,
            title: `${panel} episode`,
            container_extension: panel === 'first' ? 'mp4' : 'mkv',
            direct_source: panel === 'first' ? '' : 'https://obsolete.fixture.invalid/series/old-user/old-pass/123.mkv',
          }] },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      const extension = panel === 'first' ? 'mp4' : 'mkv';
      expect(url.pathname).toBe(`/series/${panel}-user/${panel}-pass/123.${extension}`);
      return new Response(`${panel} video`, { headers: { 'Content-Type': 'text/plain' } });
    });
  });

  afterAll(() => {
    tokenCache.clear();
    epgDb.close();
    db.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('keeps colliding episode IDs on their authorized panel without upstream direct-source bypasses', async () => {
    const episodes = [];
    for (const seriesId of assignments) {
      const response = await request(app).get('/player_api.php').query({
        ...credentials, action: 'get_series_info', series_id: seriesId,
      });
      expect(response.status).toBe(200);
      episodes.push(response.body.episodes[1][0]);
    }
    expect(episodes[0].id).not.toBe(episodes[1].id);
    for (const [index, panel] of ['first', 'second'].entries()) {
      const episode = episodes[index];
      expect(Number(episode.id)).toBeLessThan(2 ** 31);
      const response = await request(app).get(
        `/series/${credentials.username}/${credentials.password}/${episode.id}.${episode.container_extension}`,
      );
      expect(response.status).toBe(200);
      expect(response.text).toBe(`${panel} video`);
      expect(episode.direct_source).toBe('');
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_series_episodes').get().count).toBe(2);
  });
});
