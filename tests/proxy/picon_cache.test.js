import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { Readable } from 'stream';

// Mock dependencies
vi.mock('node-fetch');

vi.mock('fs', () => {
  const existsSync = vi.fn();
  const mkdirSync = vi.fn();
  const createReadStream = vi.fn();
  const writeFileSync = vi.fn();
  const readdirSync = vi.fn();
  const unlinkSync = vi.fn();

  return {
    default: {
      existsSync,
      mkdirSync,
      createReadStream,
      writeFileSync,
      readdirSync,
      unlinkSync,
      promises: {
        writeFile: vi.fn(),
        rename: vi.fn(),
        unlink: vi.fn()
      }
    },
    existsSync,
    mkdirSync,
    createReadStream,
    writeFileSync,
    readdirSync,
    unlinkSync,
    promises: {
        writeFile: vi.fn(),
        rename: vi.fn(),
        unlink: vi.fn()
    }
  };
});

// Mock Auth Middleware
vi.mock('../../src/middleware/auth.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, username: 'admin', is_admin: true };
    next();
  }
}));

// Mock Security Middleware
vi.mock('../../src/middleware/security.js', () => ({
  ipBlocker: (req, res, next) => next(),
  securityHeaders: (req, res, next) => next(),
  apiLimiter: (req, res, next) => next(),
  authLimiter: (req, res, next) => next(),
  clientLogLimiter: (req, res, next) => next()
}));

describe('Picon Cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch from URL and cache it on MISS', async () => {
    // Setup mocks
    fs.existsSync.mockImplementation((p) => {
        // Ensure directory check passes if logic checks it
        if (p.includes('picons')) return false;
        return false;
    });
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});

    // Mock Fetch
    const mockBuffer = Buffer.from('fake-image');
    fetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => mockBuffer,
      body: Readable.from(mockBuffer)
    });

    const res = await request(app).get('/api/proxy/image?url=http://example.com/logo.png');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    // Check if body matches
    expect(res.body.toString()).toBe('fake-image');
    expect(fs.promises.writeFile).toHaveBeenCalled();
  });

  it('should serve from cache on HIT', async () => {
    // Setup mocks
    fs.existsSync.mockReturnValue(true);
    const mockReadStream = {
      pipe: (res) => { res.write('cached-image'); res.end(); }
    };
    fs.createReadStream.mockReturnValue(mockReadStream);

    const res = await request(app).get('/api/proxy/image?url=http://example.com/logo.png');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body.toString()).toBe('cached-image');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should prune cache', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['file1.png', 'file2.png']);
    fs.unlinkSync.mockImplementation(() => {});

    const res = await request(app).delete('/api/proxy/picons');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });
});
