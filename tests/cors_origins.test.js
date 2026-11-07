import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';

afterEach(() => vi.unstubAllEnvs());
it.each([
  ['*', 'https://external-player.example', true],
  [' https://one.example, https://two.example ', 'https://two.example', true],
  ['https://one.example', 'https://external-player.example', false],
  ['', 'https://external-player.example', false],
])('enforces ALLOWED_ORIGINS=%s for %s', async (setting, origin, allowed) => {
  vi.stubEnv('ALLOWED_ORIGINS', setting);
  vi.resetModules();
  const { default: app } = await import('../src/app.js');
  const res = await request(app).options('/player_api.php').set('Origin', origin).set('Access-Control-Request-Method', 'GET');
  expect(res.headers['access-control-allow-origin']).toBe(allowed ? origin : undefined);
  if (allowed) expect(res.headers['access-control-allow-credentials']).toBe('true');
});
