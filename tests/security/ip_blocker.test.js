import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock dependencies
vi.mock('../../src/database/db.js', () => {
  return {
    default: {
      prepare: vi.fn()
    }
  };
});

import db from '../../src/database/db.js';
import { ipBlocker } from '../../src/middleware/security.js';

const app = express();
app.use(ipBlocker);
app.get('/test', (req, res) => res.json({ success: true }));

describe('IP Blocker Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should allow access for unblocked IP', async () => {
    // 1. Whitelist check -> null
    // 2. Blocklist check -> null
    const getMock = vi.fn().mockReturnValue(null);
    db.prepare.mockReturnValue({ get: getMock });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('should block access for blocked IP and return JSON', async () => {
    const now = Math.floor(Date.now() / 1000);
    const blockedIp = {
      ip: '::ffff:127.0.0.1',
      reason: 'Too many failed attempts',
      expires_at: now + 3600 // Valid block
    };

    const getMock = vi.fn()
        .mockReturnValueOnce(null) // Whitelist: null
        .mockReturnValueOnce(blockedIp); // Blocklist: blockedIp

    db.prepare.mockReturnValue({ get: getMock });

    const res = await request(app).get('/test');

    // Before fix, this returns 403 but text "Access Denied"
    expect(res.status).toBe(403);

    // This assertion should fail before fix
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toContain('Access Denied');
  });
});
