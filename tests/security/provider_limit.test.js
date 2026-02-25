import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as streamController from '../../src/controllers/streamController.js';
import streamManager from '../../src/services/streamManager.js';
import { getXtreamUser } from '../../src/services/authService.js';

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
                    get: vi.fn().mockImplementation((streamId) => {
                        // Return based on streamId to test different scenarios
                        const base = {
                            user_channel_id: 1,
                            provider_channel_id: 1,
                            remote_stream_id: '123',
                            name: 'Test Channel',
                            metadata: '{}',
                            provider_id: 100, // Provider 100
                            provider_url: 'http://example.com',
                            provider_user: 'user',
                            provider_pass: 'pass',
                            user_agent: 'TestAgent',
                            provider_max_connections: 0
                        };

                        if (streamId === 101) {
                            return { ...base, provider_id: 101, provider_max_connections: 1 };
                        }
                        return base;
                    })
                };
            }
            if (query.includes('SELECT id FROM stream_stats')) {
                 return { get: vi.fn().mockReturnValue({ id: 1 }) };
            }
            return { run: vi.fn(), get: vi.fn() };
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
        add: vi.fn(),
        remove: vi.fn(),
        cleanupUser: vi.fn(),
        isSessionActive: vi.fn().mockResolvedValue(false),
        getUserConnectionCount: vi.fn().mockResolvedValue(0),
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
        safeLookup: vi.fn()
    };
});

// Mock crypto
vi.mock('../../src/utils/crypto.js', () => ({
    decrypt: vi.fn((val) => val),
    encrypt: vi.fn((val) => val)
}));

describe('Provider Connection Limit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should allow stream if provider max_connections is 0', async () => {
        getXtreamUser.mockResolvedValue({ id: 1, username: 'user1', max_connections: 0 });
        // Default mock returns provider_max_connections: 0 for streamId!=101

        const req = {
            params: { stream_id: '1' },
            ip: '127.0.0.1',
            query: { transcode: 'true' },
            path: 'stream.ts',
            on: vi.fn()
        };
        const res = { sendStatus: vi.fn(), setHeader: vi.fn(), send: vi.fn(), status: vi.fn().mockReturnThis() };

        await streamController.proxyLive(req, res);

        expect(streamManager.getProviderConnectionCount).not.toHaveBeenCalled();
        expect(streamManager.add).toHaveBeenCalled();
    });

    it('should block stream if provider active >= provider max_connections', async () => {
        getXtreamUser.mockResolvedValue({ id: 1, username: 'user1', max_connections: 0 });
        streamManager.getProviderConnectionCount.mockResolvedValue(1);

        const req = {
            params: { stream_id: '101' }, // Triggers provider limit 1
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

        expect(streamManager.getProviderConnectionCount).toHaveBeenCalledWith(101);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Provider max connections'));
        expect(streamManager.add).not.toHaveBeenCalled();
    });

    it('should allow stream if provider active < provider max_connections', async () => {
        getXtreamUser.mockResolvedValue({ id: 1, username: 'user1', max_connections: 0 });
        streamManager.getProviderConnectionCount.mockResolvedValue(0);

        const req = {
            params: { stream_id: '101' },
            ip: '127.0.0.1',
            query: { transcode: 'true' },
            path: 'stream.ts',
            on: vi.fn()
        };
        const res = { sendStatus: vi.fn(), setHeader: vi.fn(), send: vi.fn(), status: vi.fn().mockReturnThis() };

        await streamController.proxyLive(req, res);

        expect(streamManager.getProviderConnectionCount).toHaveBeenCalledWith(101);
        expect(streamManager.add).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), 101);
    });
});
