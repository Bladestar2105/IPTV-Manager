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
// Vitest hoists the mocks before these static imports.
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

    it('should handle presentationURL root request', async () => {
        const res = await request(app).get('/hdhr/TOKEN');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/xml');
    });

    it('should handle presentationURL root request with trailing slash', async () => {
        const res = await request(app).get('/hdhr/TOKEN/');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/xml');
    });

    it('should handle double slash in lineup.json request', async () => {
        const res = await request(app).get('/hdhr/TOKEN//lineup.json');
        expect(res.status).toBe(200);
    });
});
