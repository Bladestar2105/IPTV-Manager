
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as streamController from '../../src/controllers/streamController.js';
import fetch from 'node-fetch';
import { safeLookup } from '../../src/utils/helpers.js';
import { getXtreamUser } from '../../src/services/authService.js';
import db from '../../src/database/db.js';
import streamManager from '../../src/services/streamManager.js';
import { isSafeUrl, getBaseUrl } from '../../src/utils/helpers.js';
import { decrypt, encrypt } from '../../src/utils/crypto.js';

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
                text: () => Promise.resolve('<MPD>test</MPD>'),
                url: url
            };
        })
    };
});

// Mock database
vi.mock('../../src/database/db.js', () => ({
    default: {
        prepare: vi.fn((query) => {
            // Mock getChannel
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
            // Mock getStat
            if (query.includes('SELECT id FROM stream_stats')) {
                 return { get: vi.fn().mockReturnValue({ id: 1 }) };
            }
            // Mock updateStat/insertStat
            return { run: vi.fn(), get: vi.fn() };
        })
    }
}));

// Mock auth service
vi.mock('../../src/services/authService.js', () => ({
    getXtreamUser: vi.fn().mockResolvedValue({
        id: 1,
        username: 'testuser',
        is_share_guest: false,
        allowed_channels: [1]
    })
}));

// Mock stream manager
vi.mock('../../src/services/streamManager.js', () => ({
    default: {
        add: vi.fn(),
        remove: vi.fn(),
        cleanupUser: vi.fn(),
        localStreams: new Map()
    }
}));

// Mock helpers
vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isSafeUrl: vi.fn().mockResolvedValue(true), // Mock isSafeUrl to pass
        getBaseUrl: vi.fn().mockReturnValue('http://localhost:3000'),
        // safeLookup: actual.safeLookup // We use the real one if possible, but mocked implies imported
    };
});

// Mock crypto
vi.mock('../../src/utils/crypto.js', () => ({
    decrypt: vi.fn((val) => val), // Echo value (mock decrypt implies input is valid json string usually, but here we just echo)
    encrypt: vi.fn((val) => val)
}));

// Adjust decrypt mock to return parsed object if input is stringified json
// Wait, my mock above just echoes. So if I pass '{"u":...}', it returns '{"u":...}'.
// But the code expects `JSON.parse(decrypted)`.
// So I should just use the real crypto or make decrypt return the string I passed.

describe('Stream Controller Security', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('proxyMpd should use an agent with safeLookup for fetch', async () => {
        const req = {
            params: { stream_id: '1', username: 'u', password: 'p', 0: 'manifest.mpd' },
            ip: '127.0.0.1',
            on: vi.fn(),
            query: {}
        };
        const res = {
            sendStatus: vi.fn(),
            setHeader: vi.fn(),
            send: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        await streamController.proxyMpd(req, res);

        expect(fetch).toHaveBeenCalled();
        const callArgs = fetch.mock.calls[0];
        const options = callArgs[1];

        // Ensure agent is defined
        expect(options.agent).toBeDefined();

        // Verify it's a function (for protocol switching)
        expect(typeof options.agent).toBe('function');

        // Check the agent returned
        const agent = options.agent(new URL('http://example.com'));

        // Check if lookup property is set (it should be our safeLookup function)
        expect(agent.options.lookup).toBeDefined();
        // Since safeLookup is imported, we can check if it matches the imported function or name
        expect(agent.options.lookup.name).toBe('safeLookup');
    });

    it('proxySegment should use an agent with safeLookup for fetch', async () => {
         const req = {
            query: { data: '{"u": "http://example.com/seg.ts"}' }, // Mock decrypt just echoes this
            on: vi.fn()
        };
        const res = {
            sendStatus: vi.fn(),
            setHeader: vi.fn(),
            send: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        await streamController.proxySegment(req, res);

        expect(fetch).toHaveBeenCalled();
        // Check the last call
        const callArgs = fetch.mock.calls[fetch.mock.calls.length - 1];
        const options = callArgs[1];
        expect(options.agent).toBeDefined();
        const agent = options.agent(new URL('http://example.com'));
        expect(agent.options.lookup.name).toBe('safeLookup');
    });
});
