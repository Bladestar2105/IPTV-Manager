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
  const createWriteStream = vi.fn();
  const writeFileSync = vi.fn();
  const readdirSync = vi.fn();
  const unlinkSync = vi.fn();

  return {
    default: {
      existsSync,
      mkdirSync,
      createReadStream,
      createWriteStream,
      writeFileSync,
      readdirSync,
      unlinkSync,
      promises: {
        writeFile: vi.fn(),
        rename: vi.fn(),
        unlink: vi.fn(),
        readdir: vi.fn(),
        access: vi.fn()
      },
      constants: {
        F_OK: 0
      }
    },
    existsSync,
    mkdirSync,
    createReadStream,
    createWriteStream,
    writeFileSync,
    readdirSync,
    unlinkSync,
    constants: {
        F_OK: 0
    },
    promises: {
        writeFile: vi.fn(),
        rename: vi.fn(),
        unlink: vi.fn(),
        readdir: vi.fn(),
        access: vi.fn()
    }
  };
});

// Mock Auth Middleware
// Mock authService getXtreamUser to let authenticateAnyToken pass
vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn().mockResolvedValue({ id: 1, username: 'admin', is_admin: true })
}));

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
    fs.promises.access.mockRejectedValue(new Error('ENOENT'));
    fs.existsSync.mockImplementation((p) => {
        // Ensure directory check passes if logic checks it
        if (p.includes('picons')) return false;
        return false;
    });
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.createWriteStream.mockReturnValue({
        on: vi.fn(),
        once: vi.fn(),
        emit: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        writableEnded: true
    });

    // Mock Fetch
    const mockBuffer = Buffer.from('fake-image');
    fetch.mockResolvedValue({
      ok: true,
      headers: {
          get: (key) => {
              if (key === 'content-type') return 'image/png';
              if (key === 'content-length') return mockBuffer.length.toString();
              return null;
          }
      },
      arrayBuffer: async () => mockBuffer,
      body: Readable.from(mockBuffer)
    });

    const res = await request(app).get('/api/proxy/image?url=http://example.com/logo.png&token=fake-token');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    // Check if body matches
    expect(res.body.toString()).toBe('fake-image');
    expect(fs.promises.rename).toHaveBeenCalled();
  });

  it('should serve from cache on HIT', async () => {
    // Setup mocks
    fs.promises.access.mockResolvedValue();
    fs.existsSync.mockReturnValue(true);
    const mockReadStream = {
      pipe: (res) => { res.write('cached-image'); res.end(); }
    };
    fs.createReadStream.mockReturnValue(mockReadStream);

    const res = await request(app).get('/api/proxy/image?url=http://example.com/logo.png&token=fake-token');

    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.body.toString()).toBe('cached-image');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should prune cache', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.promises.readdir.mockResolvedValue(['file1.png', 'file2.png']);
    fs.promises.unlink.mockResolvedValue();

    const res = await request(app).delete('/api/proxy/picons').set('Authorization', 'Bearer fake-token');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(fs.promises.unlink).toHaveBeenCalledTimes(2);
  });

  it('should return 0 deleted if cache dir does not exist', async () => {
    fs.promises.readdir.mockRejectedValue({ code: 'ENOENT' });
    const res = await request(app).delete('/api/proxy/picons').set('Authorization', 'Bearer fake-token');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
  });
});
