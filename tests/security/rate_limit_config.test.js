import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

async function loadSecurityMiddleware(env = {}) {
  vi.resetModules();
  vi.doMock('../../src/database/db.js', () => ({
    default: {
      prepare: vi.fn(() => ({
        get: vi.fn(),
        run: vi.fn()
      }))
    }
  }));

  const previousEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    return await import('../../src/middleware/security.js');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function appWith(middleware) {
  const app = express();
  app.use(middleware);
  app.get('/limited', (req, res) => res.json({ ok: true }));
  return app;
}

describe('rate limit configuration', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('allows IPTV API bursts above the previous 100 request default', async () => {
    const { apiLimiter } = await loadSecurityMiddleware();
    const app = appWith(apiLimiter);

    for (let i = 0; i < 101; i += 1) {
      const response = await request(app).get('/limited');
      expect(response.status).toBe(200);
    }
  });

  it('keeps API rate limit overrides enforced from the environment', async () => {
    const { apiLimiter } = await loadSecurityMiddleware({
      API_RATE_LIMIT_MAX: '2',
      API_RATE_LIMIT_WINDOW_MS: '60000'
    });
    const app = appWith(apiLimiter);

    expect((await request(app).get('/limited')).status).toBe(200);
    expect((await request(app).get('/limited')).status).toBe(200);

    const limited = await request(app).get('/limited');

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many requests, please try again later' });
  });
});
