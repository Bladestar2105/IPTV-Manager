import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';

const { dataDir, db } = vi.hoisted(() => ({
  dataDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'iptv-resource-rate-')),
  db: { prepare: vi.fn() },
}));
vi.mock('../../src/config/constants.js', () => ({ DATA_DIR: dataDir }));
vi.mock('../../src/database/db.js', () => ({ default: db }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: vi.fn() }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: vi.fn() }));
vi.mock('../../src/controllers/shareController.js', () => ({ handleShortLink: vi.fn() }));

const user = { id: 7, token_version: 2, is_active: 1 };
let app;
let createClientResourceUrl;

async function loadApp() {
  vi.resetModules();
  vi.stubEnv('API_RATE_LIMIT_MAX', '2');
  vi.stubEnv('API_RATE_LIMIT_WINDOW_MS', '60000');
  for (const route of ['auth', 'users', 'providers', 'channels', 'streams', 'xtream', 'epg', 'system', 'hdhr', 'stalker', 'shares', 'backups', 'ai']) {
    vi.doMock(`../../src/routes/${route}.js`, () => {
      const router = express.Router();
      if (route === 'auth') router.get('/rate-test', (req, res) => res.json({ ok: true }));
      return { default: router };
    });
  }
  vi.doMock('../../src/routes/proxy.js', () => {
    const router = express.Router();
    router.all('/resource/:data/:filename', (req, res) => {
      if (!req.clientResource) return res.sendStatus(401);
      return res.json({ kind: req.clientResource.kind, rawBody: Buffer.isBuffer(req.body) });
    });
    return { default: router };
  });
  ({ default: app } = await import('../../src/app.js'));
  ({ createClientResourceUrl } = await import('../../src/services/clientResourceService.js'));
}

function grantPath(kind) {
  const url = createClientResourceUrl({ protocol: 'http', get: () => 'manager.test', app: { get: () => false }, query: {}, params: {} },
    user, 'https://provider.test/media', { kind });
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

beforeEach(async () => {
  db.prepare.mockReset();
  db.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM users') ? user : undefined }));
  await loadApp();
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('validated resource grants and general API quota', () => {
  it.each(['resource', 'license'])('keeps %s playback outside the API quota after authentication', async kind => {
    const path = grantPath(kind);
    for (let i = 0; i < 4; i++) {
      const response = kind === 'license'
        ? await request(app).post(path).set('Content-Type', 'application/json').send('{"challenge":1}')
        : await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.body.kind).toBe(kind);
      if (kind === 'license') expect(response.body.rawBody).toBe(true);
    }
    expect(db.prepare.mock.calls.filter(([sql]) => sql.includes('FROM users'))).toHaveLength(4);
    expect((await request(app).get('/api/rate-test')).status).toBe(200);
    expect((await request(app).get('/api/rate-test')).status).toBe(200);
    expect((await request(app).get('/api/rate-test')).status).toBe(429);
    expect((await request(app).get(path)).status).toBe(200);
  });

  it('still limits image grants', async () => {
    const path = grantPath('image');
    expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get(path)).status).toBe(429);
  });

  it.each(['invalid', 'tampered'])('does not exempt %s grants or spoofed resource headers', async variant => {
    const path = variant === 'invalid' ? '/api/proxy/resource/invalid/resource'
      : grantPath('resource').replace('/api/proxy/resource/', '/api/proxy/resource/x');
    expect((await request(app).get(path).set('X-Client-Resource', 'license')).status).toBe(401);
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path)).status).toBe(429);
  });

  it('rechecks revoked grants before applying the media exemption', async () => {
    const path = grantPath('resource');
    db.prepare.mockImplementation(() => ({ get: () => undefined }));
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path)).status).toBe(429);
  });

  it('keeps IP blocking ahead of authenticated media requests', async () => {
    const path = grantPath('resource');
    db.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM blocked_ips')
      ? { expires_at: Math.floor(Date.now() / 1000) + 60 } : undefined }));
    expect((await request(app).get(path)).status).toBe(403);
    expect(db.prepare.mock.calls.some(([sql]) => sql.includes('FROM users'))).toBe(false);
  });

});
