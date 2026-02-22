import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';

// Mock node-fetch
const { fetchMock } = vi.hoisted(() => {
    return { fetchMock: vi.fn() };
});
vi.mock('node-fetch', () => ({
    default: fetchMock,
}));

// Mock helpers
const { isSafeUrlMock, safeLookupMock } = vi.hoisted(() => ({
    isSafeUrlMock: vi.fn(),
    safeLookupMock: vi.fn((hostname, options, cb) => cb(null, '1.2.3.4', 4))
}));

vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isSafeUrl: isSafeUrlMock,
        safeLookup: safeLookupMock,
    };
});

// Mock auth middleware
vi.mock('../../src/middleware/auth.js', () => ({
    authenticateToken: (req, res, next) => {
        req.user = { id: 1, is_admin: true };
        next();
    }
}));

// Mock security middleware
vi.mock('../../src/middleware/security.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        securityHeaders: (req, res, next) => next(),
        ipBlocker: (req, res, next) => next(),
        apiLimiter: (req, res, next) => next(),
        authLimiter: (req, res, next) => next(),
    };
});

import app from '../../src/app.js';

describe('Proxy SSRF Vulnerability', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should BLOCK access to localhost via /api/proxy/image', async () => {
        isSafeUrlMock.mockResolvedValue(false);

        const randomId = crypto.randomUUID();
        const targetUrl = `http://localhost:3000/sensitive-data/${randomId}`;

        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => Buffer.from('fake-image'),
        });

        const res = await request(app)
            .get('/api/proxy/image')
            .query({ url: targetUrl });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(res.status).not.toBe(200);
    });

    it('should ALLOW access to external public images', async () => {
        isSafeUrlMock.mockResolvedValue(true);

        const randomId = crypto.randomUUID();
        const targetUrl = `http://example.com/image-${randomId}.png`;

        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => Buffer.from('fake-image'),
        });

        const res = await request(app)
            .get('/api/proxy/image')
            .query({ url: targetUrl });

        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalled();
        expect(fetchMock.mock.calls[0][0]).toBe(targetUrl);
    });
});
