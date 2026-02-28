import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';

// Mock auth middleware
vi.mock('../../src/middleware/auth.js', () => ({
    authenticateToken: (req, res, next) => {
        req.user = { id: 1, is_admin: true };
        next();
    }
}));

// Mock authService getXtreamUser to let authenticateAnyToken pass
vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn().mockResolvedValue({ id: 1, is_admin: true })
}));

// Mock security middleware to avoid DB errors
vi.mock('../../src/middleware/security.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        ipBlocker: (req, res, next) => next()
    };
});

// Mock node-fetch using vi.hoisted
const { mockFetch } = vi.hoisted(() => {
    return { mockFetch: vi.fn() };
});

vi.mock('node-fetch', () => {
    return {
        default: mockFetch
    };
});

// Mock safeLookup and isSafeUrl
vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isSafeUrl: vi.fn().mockResolvedValue(true),
        safeLookup: vi.fn((hostname, options, callback) => callback(null, '8.8.8.8', 4))
    };
});

// Mock fs
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        writeFileSync: vi.fn(),
        createReadStream: vi.fn(),
        unlinkSync: vi.fn(),
        mkdirSync: vi.fn()
    };
});

import app from '../../src/app.js';

describe('Proxy DoS Protection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should reject requests with Content-Length > 5MB', async () => {
        const size = 6 * 1024 * 1024; // 6MB

        const mockResponse = {
            ok: true,
            status: 200,
            headers: {
                get: (key) => {
                    if (key.toLowerCase() === 'content-type') return 'image/png';
                    if (key.toLowerCase() === 'content-length') return String(size);
                    return null;
                }
            },
            body: Readable.from(Buffer.from('small'))
        };
        mockFetch.mockResolvedValue(mockResponse);

        const res = await request(app)
            .get('/api/proxy/image')
            .query({ token: 'fake-token', url: 'http://example.com/large-header.png' });

        expect(res.status).toBe(413);
    });

    it('should reject requests where stream exceeds 5MB', async () => {
        const size = 6 * 1024 * 1024; // 6MB
        const largeBuffer = Buffer.alloc(size, 'A');

        const mockResponse = {
            ok: true,
            status: 200,
            headers: {
                get: (key) => {
                    if (key.toLowerCase() === 'content-type') return 'image/png';
                    return null;
                }
            },
            body: Readable.from(largeBuffer)
        };
        mockFetch.mockResolvedValue(mockResponse);

        const res = await request(app)
            .get('/api/proxy/image')
            .query({ token: 'fake-token', url: 'http://example.com/large-stream.png' });

        expect(res.status).toBe(413);
    });

    it('should accept valid small images', async () => {
        const size = 1 * 1024 * 1024; // 1MB
        const validBuffer = Buffer.alloc(size, 'B');

        const mockResponse = {
            ok: true,
            status: 200,
            headers: {
                get: (key) => {
                    if (key.toLowerCase() === 'content-type') return 'image/png';
                    if (key.toLowerCase() === 'content-length') return String(size);
                    return null;
                }
            },
            body: Readable.from(validBuffer)
        };
        mockFetch.mockResolvedValue(mockResponse);

        const res = await request(app)
            .get('/api/proxy/image')
            .query({ token: 'fake-token', url: 'http://example.com/valid.png' });

        expect(res.status).toBe(200);
        expect(res.header['content-type']).toBe('image/png');
    });
});
