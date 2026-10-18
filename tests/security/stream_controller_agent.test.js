import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import { safeLookup } from '../../src/utils/helpers.js';
import { encrypt } from '../../src/utils/crypto.js';
import fetch from 'node-fetch';

const fixtures = vi.hoisted(() => ({
    user: { id: 1, username: 'agent-user', is_active: 1, token_version: 0, max_connections: 0 },
    channel: { user_channel_id: 1, provider_channel_id: 1, provider_id: 1, remote_stream_id: '123',
        name: 'Security channel', metadata: '{}', provider_url: 'http://example.com',
        provider_user: 'provider-user', provider_pass: 'provider-pass', user_agent: 'TestAgent',
        category_owner_id: 1, provider_owner_id: 1, granted_by_admin: 0 },
}));
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../../src/database/db.js', () => ({ default: {
    prepare: vi.fn(sql => {
        if (sql.includes('FROM users')) return { get: () => fixtures.user };
        if (sql.includes('FROM authorized_user_channels')) return { get: () => ({ ...fixtures.channel }) };
        if (sql.includes('url LIKE')) return { all: () => [{ id: 1, url: 'http://example.com', username: 'provider-user', password: 'provider-pass', max_connections: 0 }] };
        return { get: () => null, all: () => [], run: () => ({}) };
    }),
} }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: async () => fixtures.user }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: () => null, getLogoCacheHash: () => 'image', registerProviderCachedIcon: vi.fn() }));
vi.mock('../../src/services/streamManager.js', () => ({ default: {
    add: vi.fn(), remove: vi.fn(), touch: vi.fn(), cleanupUser: vi.fn(), cleanupSession: vi.fn(),
    isSessionActive: async () => false, getUserConnectionCount: async () => 0,
    getProviderConnectionCount: async () => 0, localStreams: new Map(),
} }));
vi.mock('../../src/utils/helpers.js', async original => ({ ...(await original()), isSafeUrl: vi.fn(async () => true) }));

const { proxyMpd, proxySegment } = await import('../../src/controllers/streamController.js');
const { default: router } = await import('../../src/routes/proxy.js');
const app = express();
app.get('/mpd/:stream_id/:mpdPath', proxyMpd);
app.get('/legacy/:username/:password/:filename', proxySegment);
app.use('/api/proxy', router);
const response = url => ({ url, status: 200, ok: true, headers: new Headers({ 'content-type': 'video/mp2t' }), body: Readable.from(['media']) });
const assertPinned = options => {
    expect(options.agent).toBeTypeOf('function');
    for (const protocol of ['http:', 'https:']) {
        const agent = options.agent(new URL(`${protocol}//example.com/segment.ts`));
        expect(agent.options.lookup).toBe(safeLookup);
        expect(agent.options.rejectUnauthorized).not.toBe(false);
    }
};
beforeEach(() => { fetch.mockReset(); fetch.mockImplementation(async url => response(url)); });

describe('pinned DNS agents in stream resource fetching', () => {
    it('pins MPD endpoint resource requests to safeLookup', async () => {
        expect((await request(app).get('/mpd/1/chunk.bin')).status).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(1);
        assertPinned(fetch.mock.calls[0][1]);
    });
    it('pins the protected relay after upgrading an old encrypted segment envelope', async () => {
        const data = encrypt(JSON.stringify({ u: 'http://example.com/seg.ts', i: 1 }));
        const upgraded = await request(app).get('/legacy/user/pass/seg.ts').query({ data });
        expect(upgraded.status).toBe(307);
        expect(fetch).not.toHaveBeenCalled();
        expect((await request(app).get(upgraded.headers.location)).status).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(1);
        assertPinned(fetch.mock.calls[0][1]);
    });
    it('keeps lookup pinning on every upstream redirect hop', async () => {
        fetch.mockImplementationOnce(async () => ({ status: 302, ok: false,
            headers: new Headers({ location: 'https://cdn.example/seg.ts' }), body: Readable.from([]),
        }));
        const data = encrypt(JSON.stringify({ u: 'http://example.com/seg.ts', i: 1 }));
        const result = await request(app).get('/legacy/user/pass/seg.ts').query({ data }).redirects(1);
        expect(result.status).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const [, options] of fetch.mock.calls) assertPinned(options);
    });
});
