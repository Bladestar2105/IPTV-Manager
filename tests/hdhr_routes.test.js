import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock dependencies
vi.mock('../src/database/db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => null)
    })),
    exec: vi.fn(),
    pragma: vi.fn()
  }
}));

vi.mock('../src/services/authService.js', () => ({
  getXtreamUser: vi.fn().mockResolvedValue({
      id: 1,
      username: 'test',
      hdhr_enabled: 1,
      hdhr_token: 'TOKEN'
  })
}));

// Import the router under test
// We need to use dynamic import or ensure mocks are set up before this import resolves if we were not using vitest.
// But vitest hoists mocks, so static import is fine.
import hdhrRouter from '../src/routes/hdhr.js';

const app = express();
app.use('/hdhr', hdhrRouter);

describe('HDHR Routing', () => {
    it('should handle standard discover.json request', async () => {
        const res = await request(app).get('/hdhr/TOKEN/discover.json');
        expect(res.status).toBe(200);
    });

    it('should handle double slash in discover.json request', async () => {
        const res = await request(app).get('/hdhr/TOKEN//discover.json');
        expect(res.status).toBe(200);
    });

    it('should handle double slash in device.xml request', async () => {
        const res = await request(app).get('/hdhr/TOKEN//device.xml');
        expect(res.status).toBe(200);
    });

    it('should handle double slash in lineup_status.json request', async () => {
        const res = await request(app).get('/hdhr/TOKEN//lineup_status.json');
        expect(res.status).toBe(200);
    });

    it('should handle double slash in lineup.json request', async () => {
        const res = await request(app).get('/hdhr/TOKEN//lineup.json');
        expect(res.status).toBe(200);
    });
});
