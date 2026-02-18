
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import db, { initDb } from '../../src/database/db.js';
import { encrypt } from '../../src/utils/crypto.js';
import fetch from 'node-fetch';

// Mock isSafeUrl
vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isSafeUrl: vi.fn().mockResolvedValue(true),
        getBaseUrl: actual.getBaseUrl
    };
});

// Mock fetch
vi.mock('node-fetch', () => {
    return {
        default: vi.fn().mockImplementation(async (url, options) => {
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (name) => {
                        if (name.toLowerCase() === 'content-type') return 'video/mp2t';
                        if (name.toLowerCase() === 'content-length') return '18';
                        return null;
                    }
                },
                body: {
                    pipe: (res) => {
                        res.write('fake video content');
                        res.end();
                    },
                    on: () => {},
                    destroy: () => {}
                },
                // Expose options for verification
                _options: options
            };
        })
    };
});

describe('Segment Encryption Format', () => {
    let userToken;
    let userId;
    const username = 'enc_test_user';

    beforeAll(async () => {
        initDb(true);

        // Clean up
        try {
            const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
            if (existing) {
                db.prepare('DELETE FROM temporary_tokens WHERE user_id = ?').run(existing.id);
                db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);
            }
        } catch(e) {}

        const info = db.prepare('INSERT INTO users (username, password, is_active, webui_access, hdhr_enabled) VALUES (?, ?, 1, 1, 0)').run(username, 'password');
        userId = info.lastInsertRowid;

        const token = 'enc-valid-token-123';
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, now + 3600);
        userToken = token;
    });

    afterAll(() => {
        try {
            db.prepare('DELETE FROM temporary_tokens WHERE user_id = ?').run(userId);
            db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        } catch(e) {}
    });

    it('should support LEGACY format (all data in "data" param)', async () => {
        const targetUrl = 'http://example.com/legacy.ts';
        const payload = {
            u: targetUrl,
            h: { 'X-Custom-Header': 'LegacyHeader' },
            s: true
        };
        const encrypted = encrypt(JSON.stringify(payload));

        const res = await request(app)
            .get(`/live/segment/${username}/password/seg.ts`)
            .query({ token: userToken, data: encrypted });

        expect(res.status).toBe(200);

        // Verify fetch was called with correct headers
        const lastCall = fetch.mock.calls[fetch.mock.calls.length - 1];
        expect(lastCall[0]).toBe(targetUrl);
        expect(lastCall[1].headers).toHaveProperty('X-Custom-Header', 'LegacyHeader');
    });

    it('should support OPTIMIZED format (url in "data", headers in "base")', async () => {
        const targetUrl = 'http://example.com/optimized.ts';
        const basePayload = {
            h: { 'X-Custom-Header': 'OptimizedHeader' },
            s: true
        };
        const baseEncrypted = encrypt(JSON.stringify(basePayload));

        const dataPayload = {
            u: targetUrl
        };
        const dataEncrypted = encrypt(JSON.stringify(dataPayload));

        const res = await request(app)
            .get(`/live/segment/${username}/password/seg.ts`)
            .query({ token: userToken, data: dataEncrypted, base: baseEncrypted });

        expect(res.status).toBe(200);

        // Verify fetch was called with correct headers
        const lastCall = fetch.mock.calls[fetch.mock.calls.length - 1];
        expect(lastCall[0]).toBe(targetUrl);
        expect(lastCall[1].headers).toHaveProperty('X-Custom-Header', 'OptimizedHeader');
    });
});
