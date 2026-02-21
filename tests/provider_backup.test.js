
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as streamController from '../src/controllers/streamController.js';

// Mocks
const { mockDb, mockFetch } = vi.hoisted(() => {
    return {
        mockDb: {
            prepare: vi.fn(),
            exec: vi.fn()
        },
        mockFetch: vi.fn()
    };
});

vi.mock('../src/database/db.js', () => ({
    default: mockDb
}));

vi.mock('node-fetch', () => ({
    default: mockFetch
}));

vi.mock('../src/services/streamManager.js', () => ({
    default: {
        add: vi.fn(),
        remove: vi.fn(),
        cleanupUser: vi.fn(),
        localStreams: { set: vi.fn() }
    }
}));

vi.mock('../src/services/authService.js', () => ({
    getXtreamUser: vi.fn(async () => ({ id: 1, username: 'testuser', is_share_guest: false }))
}));

vi.mock('../src/utils/helpers.js', () => ({
    getBaseUrl: vi.fn(() => 'http://localhost:3000'),
    isSafeUrl: vi.fn(async () => true),
    safeLookup: vi.fn((hostname, options, cb) => cb(null, '127.0.0.1', 4))
}));

vi.mock('../src/utils/crypto.js', () => ({
    decrypt: vi.fn((val) => val),
    encrypt: vi.fn((val) => 'enc:' + val)
}));

vi.mock('../src/config/constants.js', () => ({
    DEFAULT_USER_AGENT: 'TestAgent',
    BCRYPT_ROUNDS: 1,
    DATA_DIR: '/tmp',
    EPG_CACHE_DIR: '/tmp/epg'
}));

// Mock fluent-ffmpeg module
vi.mock('fluent-ffmpeg', () => ({
    default: vi.fn(() => ({
        inputFormat: vi.fn().mockReturnThis(),
        outputOptions: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
        pipe: vi.fn()
    }))
}));

describe('Stream Controller - Backup Failover', () => {
    let mockReq, mockRes;

    beforeEach(() => {
        vi.clearAllMocks();
        mockReq = {
            params: { stream_id: '123', username: 'u', password: 'p' },
            query: {},
            path: '/live/u/p/123.ts',
            headers: {},
            ip: '127.0.0.1',
            on: vi.fn()
        };
        mockRes = {
            sendStatus: vi.fn(),
            setHeader: vi.fn(),
            status: vi.fn(),
            send: vi.fn(),
            headersSent: false
        };

        // Mock DB prepare to handle different queries
        mockDb.prepare.mockImplementation((query) => {
            if (query.trim().startsWith('SELECT') && query.includes('user_channels uc')) {
                return {
                    get: vi.fn().mockReturnValue({
                        user_channel_id: 1,
                        provider_channel_id: 10,
                        remote_stream_id: 555,
                        name: 'Test Channel',
                        metadata: '{}',
                        provider_url: 'http://primary.com',
                        provider_user: 'user',
                        provider_pass: 'pass',
                        backup_urls: JSON.stringify(['http://backup1.com', 'http://backup2.com'])
                    })
                };
            }
            // Stats or other queries
            return {
                get: vi.fn().mockReturnValue({ id: 99 }),
                run: vi.fn()
            };
        });
    });

    it('should use primary URL if it succeeds', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { pipe: vi.fn(), on: vi.fn() }
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('http://primary.com'), expect.any(Object));
        expect(mockRes.sendStatus).not.toHaveBeenCalled();
    });

    it('should failover to first backup if primary fails', async () => {
        // First call fails
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503
        });
        // Second call succeeds
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: { pipe: vi.fn(), on: vi.fn() }
        });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('http://primary.com'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('http://backup1.com'), expect.any(Object));
        expect(mockRes.sendStatus).not.toHaveBeenCalled();
    });

    it('should failover to second backup if first backup also fails', async () => {
        mockFetch
            .mockResolvedValueOnce({ ok: false, status: 500 }) // Primary
            .mockResolvedValueOnce({ ok: false, status: 404 }) // Backup 1
            .mockResolvedValueOnce({ // Backup 2
                ok: true,
                status: 200,
                headers: { get: () => null },
                body: { pipe: vi.fn(), on: vi.fn() }
            });

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(mockFetch).toHaveBeenLastCalledWith(expect.stringContaining('http://backup2.com'), expect.any(Object));
    });

    it('should return 502 if all URLs fail', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 }); // All fail

        await streamController.proxyLive(mockReq, mockRes);

        expect(mockFetch).toHaveBeenCalledTimes(3); // Primary + 2 backups
        expect(mockRes.sendStatus).toHaveBeenCalledWith(502);
    });
});
