
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as streamController from '../../src/controllers/streamController.js';
import fetch from 'node-fetch';
import streamManager from '../../src/services/streamManager.js';

// --- Mocks ---

// Mock dotenv
vi.mock('dotenv', () => ({
    default: { config: vi.fn() },
    config: vi.fn()
}));

// Mock fluent-ffmpeg
vi.mock('fluent-ffmpeg', () => ({
    default: vi.fn(() => ({
        inputFormat: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
        pipe: vi.fn()
    })),
    setFfmpegPath: vi.fn()
}));

// Mock fetch
vi.mock('node-fetch', () => {
    return {
        default: vi.fn().mockImplementation(async (url, opts) => {
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                body: { pipe: () => {}, on: () => {}, destroy: () => {} },
                text: () => Promise.resolve('#EXTM3U\n#EXTINF:-1,Test\nhttp://example.com/segment.ts'),
                url: url
            };
        })
    };
});

// Mock database
vi.mock('../../src/database/db.js', () => ({
    default: {
        prepare: vi.fn((query) => {
            if (query.includes('user_channels')) {
                return {
                    get: vi.fn().mockReturnValue({
                        user_channel_id: 1,
                        provider_channel_id: 1,
                        remote_stream_id: '123',
                        name: 'Test Channel',
                        metadata: '{}',
                        provider_url: 'http://example.com',
                        provider_user: 'user',
                        provider_pass: 'pass',
                        user_agent: 'TestAgent'
                    })
                };
            }
            if (query.includes('FROM providers WHERE user_id = ? AND url LIKE ?')) {
                return {
                    all: vi.fn().mockImplementation((userId, urlPattern) => {
                        return [
                            { id: 100, url: 'http://example.com', username: 'user', password: 'pass', max_connections: 0 }
                        ];
                    })
                };
            }
            if (query.includes('SELECT id FROM stream_stats')) {
                 return { get: vi.fn().mockReturnValue({ id: 1 }) };
            }
            return { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) };
        })
    }
}));

// Mock auth service
vi.mock('../../src/services/authService.js', () => ({
    getXtreamUser: vi.fn()
}));

// Mock stream manager
vi.mock('../../src/services/streamManager.js', () => ({
    default: {
        reserve: vi.fn(async (_id, _user, _name, _ip, _res, providers) => ({ provider: providers[0] })),
        remove: vi.fn(),
        cleanupUser: vi.fn(),
        isSessionActive: vi.fn().mockResolvedValue(false),
        getUserConnectionCount: vi.fn(),
        getProviderConnectionCount: vi.fn().mockResolvedValue(0),
        localStreams: new Map()
    }
}));

// Mock helpers
vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isSafeUrl: vi.fn().mockResolvedValue(true),
        getBaseUrl: vi.fn().mockReturnValue('http://localhost:3000'),
    };
});

// Mock crypto
vi.mock('../../src/utils/crypto.js', () => ({
    decrypt: vi.fn((val) => val),
    encrypt: vi.fn((val) => val)
}));

import { getXtreamUser } from '../../src/services/authService.js';

describe('User Connection Limit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should allow stream if max_connections is 0 (unlimited)', async () => {
        getXtreamUser.mockResolvedValue({ id: 1, username: 'user1', max_connections: 0 });
        streamManager.getUserConnectionCount.mockResolvedValue(5); // Even if 5 active

        const req = {
            params: { stream_id: '1', username: 'u', password: 'p' },
            ip: '127.0.0.1',
            query: { transcode: 'true' }, // Force stream manager logic
            path: 'stream.ts',
            on: vi.fn()
        };
        const res = {
            sendStatus: vi.fn(),
            setHeader: vi.fn(),
            send: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        await streamController.proxyLive(req, res);

        // A zero limit skips the user-count precheck.
        expect(streamManager.getUserConnectionCount).not.toHaveBeenCalled();
        expect(streamManager.reserve).toHaveBeenCalled();
    });

    it('should allow stream if active < max_connections', async () => {
        getXtreamUser.mockResolvedValue({ id: 1, username: 'user1', max_connections: 2 });
        streamManager.getUserConnectionCount.mockResolvedValue(1);

        const req = {
            params: { stream_id: '1' },
            ip: '127.0.0.1',
            query: { transcode: 'true' },
            path: 'stream.ts',
            on: vi.fn()
        };
        const res = {
            sendStatus: vi.fn(),
            setHeader: vi.fn(),
            send: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        await streamController.proxyLive(req, res);

        expect(streamManager.getUserConnectionCount).toHaveBeenCalledWith(1);
        expect(streamManager.reserve).toHaveBeenCalled();
    });

    it('should block stream if active >= max_connections', async () => {
        getXtreamUser.mockResolvedValue({ id: 1, username: 'user1', max_connections: 1 });
        streamManager.getUserConnectionCount.mockResolvedValue(1);

        const req = {
            params: { stream_id: '1' },
            ip: '127.0.0.1',
            query: { transcode: 'true' },
            path: 'stream.ts',
            on: vi.fn()
        };
        const res = {
            sendStatus: vi.fn(),
            status: vi.fn().mockReturnThis(),
            send: vi.fn()
        };

        await streamController.proxyLive(req, res);

        expect(streamManager.getUserConnectionCount).toHaveBeenCalledWith(1);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Max connections'));
        expect(streamManager.reserve).not.toHaveBeenCalled();
    });

    it('should cleanup user before checking limit for live streams', async () => {
        // Model a previous session on the same IP that cleanupUser removes.

        getXtreamUser.mockResolvedValue({ id: 1, username: 'user1', max_connections: 1 });

        // The count after cleanup leaves room for the new reservation.
        streamManager.getUserConnectionCount.mockResolvedValue(0);

        const req = {
            params: { stream_id: '1' },
            ip: '127.0.0.1',
            query: { transcode: 'true' },
            path: 'stream.ts',
            on: vi.fn()
        };
        const res = { sendStatus: vi.fn(), setHeader: vi.fn(), send: vi.fn(), status: vi.fn().mockReturnThis() };

        await streamController.proxyLive(req, res);

        // Verify cleanupUser was called
        expect(streamManager.cleanupUser).toHaveBeenCalledWith(1, '127.0.0.1');

        // Verify count check passed
        expect(streamManager.reserve).toHaveBeenCalled();
    });
});
