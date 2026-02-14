import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// Mock dependencies
vi.mock('../../src/database/db.js', () => {
  return {
    default: {
      prepare: vi.fn()
    }
  };
});

vi.mock('../../src/utils/crypto.js', () => ({
  JWT_SECRET: 'test_secret',
  encrypt: vi.fn(),
  decrypt: vi.fn()
}));

// Import authentication middleware
import { authenticateToken } from '../../src/middleware/auth.js';
import db from '../../src/database/db.js';

// Setup Express app
const app = express();
app.use(express.json());
app.get('/protected', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

describe('Authentication Token Invalidation', () => {
  const userId = 123;
  const validToken = jwt.sign(
    { id: userId, username: 'testuser', is_admin: false, is_active: 1 },
    'test_secret'
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should deny access if user is deleted from database', async () => {
    // DB returns null (user not found)
    const getMock = vi.fn().mockReturnValue(null);
    db.prepare.mockReturnValue({ get: getMock });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${validToken}`);

    // Expect 401 because user doesn't exist anymore
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('should deny access if user is disabled (is_active=0)', async () => {
    // DB returns inactive user
    const getMock = vi.fn().mockReturnValue({
      id: userId,
      username: 'testuser',
      is_active: 0, // Disabled
      is_admin: 0
    });
    db.prepare.mockReturnValue({ get: getMock });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${validToken}`);

    // Expect 401 because user is disabled
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('should deny access if webui_access is revoked for regular user', async () => {
    const getMock = vi.fn().mockReturnValue({
      id: userId,
      username: 'testuser',
      is_active: 1,
      is_admin: 0,
      webui_access: 0 // Revoked
    });
    db.prepare.mockReturnValue({ get: getMock });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error', 'WebUI access revoked');
  });

  it('should allow access if user exists and is active', async () => {
    // DB returns active user
    const getMock = vi.fn().mockReturnValue({
      id: userId,
      username: 'testuser',
      is_active: 1,
      is_admin: 0,
      webui_access: 1
    });
    db.prepare.mockReturnValue({ get: getMock });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
