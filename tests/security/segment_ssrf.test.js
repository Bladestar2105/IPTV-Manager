import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';
import app from '../../src/app.js';
import db, { initDb } from '../../src/database/db.js';
import { encrypt } from '../../src/utils/crypto.js';
import * as helpers from '../../src/utils/helpers.js';
import fetch from 'node-fetch';

vi.mock('../../src/utils/helpers.js', async original => ({
    ...(await original()),
    isSafeUrl: vi.fn(async url => !/127\.0\.0\.1|localhost|private/.test(url)),
}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
const mediaResponse = url => ({ url, status: 200, ok: true,
    headers: new Headers({ 'content-type': 'video/mp2t' }), body: Readable.from(['fake video content']),
});

describe('SSRF protection after legacy segment grant upgrade', () => {
    let userId, providerId, providerChannelId, categoryId, channelId;
    const userToken = 'ssrf-scope-valid-token';
    const username = 'ssrf_scope_user';
    beforeEach(() => {
        vi.clearAllMocks();
        fetch.mockImplementation(async url => mediaResponse(url));
    });
    beforeAll(() => {
        initDb(true);
        userId = Number(db.prepare('INSERT INTO users (username,password,is_active,webui_access,max_connections) VALUES (?,?,1,1,0)').run(username, 'password').lastInsertRowid);
        providerId = Number(db.prepare('INSERT INTO providers (name,url,username,password,user_id) VALUES (?,?,?,?,?)').run(username, 'http://example.com', 'provider-user', encrypt('provider-pass'), userId).lastInsertRowid);
        providerChannelId = Number(db.prepare('INSERT INTO provider_channels (provider_id,remote_stream_id,name) VALUES (?,?,?)').run(providerId, 123, 'Security channel').lastInsertRowid);
        categoryId = Number(db.prepare('INSERT INTO user_categories (user_id,name) VALUES (?,?)').run(userId, 'Security list').lastInsertRowid);
        channelId = Number(db.prepare("INSERT INTO user_channels (user_category_id,provider_channel_id,assignment_origin) VALUES (?,?,'manual')").run(categoryId, providerChannelId).lastInsertRowid);
        db.prepare('INSERT INTO temporary_tokens (token,user_id,expires_at) VALUES (?,?,?)').run(userToken, userId, Math.floor(Date.now() / 1000) + 3600);
    });
    afterAll(() => {
        db.prepare('DELETE FROM temporary_tokens WHERE user_id=?').run(userId);
        db.prepare('DELETE FROM user_channels WHERE id=?').run(channelId);
        db.prepare('DELETE FROM user_categories WHERE id=?').run(categoryId);
        db.prepare('DELETE FROM provider_channels WHERE id=?').run(providerChannelId);
        db.prepare('DELETE FROM providers WHERE id=?').run(providerId);
        db.prepare('DELETE FROM users WHERE id=?').run(userId);
    });
    const legacyRequest = payload => request(app).get(`/live/segment/${username}/password/seg.ts`).query({ token: userToken, data: encrypt(JSON.stringify({ i: channelId, ...payload })) });

    it.each([true, false])('rejects private upstreams even when the old encrypted safe-origin flag is %s', async s => {
        const target = 'http://127.0.0.1:8080/private-data';
        const upgraded = await legacyRequest({ u: target, s });
        expect(upgraded.status).toBe(307);
        expect(upgraded.headers.location).toMatch(/^\/api\/proxy\/resource\//);
        expect(fetch).not.toHaveBeenCalled();
        const blocked = await request(app).get(upgraded.headers.location);
        expect(blocked.status).toBe(502);
        expect(helpers.isSafeUrl).toHaveBeenCalledWith(target);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('streams authorized public resources after the Manager-local redirect', async () => {
        const target = 'http://example.com/video.ts';
        const result = await legacyRequest({ u: target, s: true }).redirects(1);
        expect(result.status).toBe(200);
        expect(result.body.toString()).toBe('fake video content');
        expect(fetch).toHaveBeenCalledWith(target, expect.any(Object));
    });
    it('blocks redirects from a public upstream to a private address', async () => {
        const target = 'http://example.com/video.ts';
        fetch.mockImplementationOnce(async () => ({ status: 302, ok: false,
            headers: new Headers({ location: 'http://127.0.0.1:8080/private-data' }), body: Readable.from([]),
        }));
        const blocked = await legacyRequest({ u: target }).redirects(1);
        expect(blocked.status, `${blocked.text}; fetch URLs: ${fetch.mock.calls.map(([url]) => url).join(', ')}`).toBe(502);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(helpers.isSafeUrl).toHaveBeenCalledWith('http://127.0.0.1:8080/private-data');
    });
});
