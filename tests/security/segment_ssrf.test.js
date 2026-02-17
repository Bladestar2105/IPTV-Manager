
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import db, { initDb } from '../../src/database/db.js';
import { encrypt } from '../../src/utils/crypto.js';
import * as helpers from '../../src/utils/helpers.js';

// Mock isSafeUrl to return true for public IPs and false for private
vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isSafeUrl: vi.fn().mockImplementation(async (url) => {
            if (url.includes('127.0.0.1') || url.includes('localhost') || url.includes('private')) {
                return false;
            }
            return true;
        }),
        getBaseUrl: actual.getBaseUrl
    };
});

// Mock fetch to simulate upstream
vi.mock('node-fetch', () => {
    return {
        default: vi.fn().mockImplementation(async (url) => {
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
                }
            };
        })
    };
});

describe('SSRF Protection in proxySegment', () => {
    let userToken;
    let userId;
    const username = 'ssrf_test_user';

    beforeAll(async () => {
        initDb(true);

        // Clean up if exists from previous run
        try {
            const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
            if (existing) {
                db.prepare('DELETE FROM temporary_tokens WHERE user_id = ?').run(existing.id);
                db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);
            }
        } catch(e) {}

        const info = db.prepare('INSERT INTO users (username, password, is_active, webui_access, hdhr_enabled) VALUES (?, ?, 1, 1, 0)').run(username, 'password');
        userId = info.lastInsertRowid;

        const token = 'ssrf-valid-token-123';
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

    it('should BLOCK access to private IP if payload does not explicitly allow it', async () => {
        const targetUrl = 'http://127.0.0.1:8080/private-data';
        const payload = {
            u: targetUrl,
            h: {},
            s: true // Simulating public origin or default
        };
        const encrypted = encrypt(JSON.stringify(payload));

        const res = await request(app)
            .get(`/live/segment/${username}/password/seg.ts`)
            .query({ token: userToken, data: encrypted });

        expect(res.status).toBe(403);
    });

    it('should ALLOW access to public IP', async () => {
        const targetUrl = 'http://example.com/video.ts';
        const payload = {
            u: targetUrl,
            h: {},
            s: true
        };
        const encrypted = encrypt(JSON.stringify(payload));

        const res = await request(app)
            .get(`/live/segment/${username}/password/seg.ts`)
            .query({ token: userToken, data: encrypted });

        expect(res.status).toBe(200);
    });

    it('should ALLOW access to private IP if origin is marked as unsafe (s: false)', async () => {
        // This simulates a scenario where the admin configured a local provider
        const targetUrl = 'http://127.0.0.1:8080/private-stream.ts';
        const payload = {
            u: targetUrl,
            h: {},
            s: false // Origin is unsafe/private
        };
        const encrypted = encrypt(JSON.stringify(payload));

        const res = await request(app)
            .get(`/live/segment/${username}/password/seg.ts`)
            .query({ token: userToken, data: encrypted });

        expect(res.status).toBe(200);
    });
});
