import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

// Use vi.hoisted to ensure mock objects are available for mocking
const { mockMainDb, mockImportDb } = vi.hoisted(() => {
    const mockMainDb = {
        prepare: vi.fn(),
        transaction: vi.fn((cb) => cb),
    };
    const mockImportDb = {
        pragma: vi.fn(),
        prepare: vi.fn(),
        transaction: vi.fn((cb) => cb),
        close: vi.fn(),
    };
    return { mockMainDb, mockImportDb };
});

// Mock better-sqlite3 constructor
vi.mock('better-sqlite3', () => {
    return {
        default: class {
            constructor() {
                return mockImportDb;
            }
        }
    };
});

// Mock main DB
vi.mock('../../src/database/db.js', () => ({
    default: mockMainDb
}));

// Mock EPG DB
vi.mock('../../src/database/epgDb.js', () => ({
    default: {
        prepare: vi.fn(),
    }
}));

// Mock node-fetch
vi.mock('node-fetch', () => ({
    default: vi.fn(() => Promise.resolve({
        ok: true,
        body: Readable.from(['<tv>\n', '</tv>'])
    }))
}));

// Mock dotenv
vi.mock('dotenv', () => ({
    default: {
        config: vi.fn(),
    }
}));

// Import subject under test
import { updateProviderEpg } from '../../src/services/epgService.js';

describe('updateProviderEpg', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default mocks
        mockMainDb.prepare.mockReturnValue({
            get: vi.fn(),
            all: vi.fn(),
            run: vi.fn(),
        });
        mockImportDb.prepare.mockReturnValue({
            run: vi.fn(),
        });
    });

    it('should use importChannelsFromProvider when epg_url is missing', async () => {
        const providerId = 1;

        // Mock provider fetch
        const mockGetProvider = vi.fn().mockReturnValue({ id: providerId, epg_url: null });
        // Mock channels fetch
        const mockGetChannels = vi.fn().mockReturnValue([
            { epg_channel_id: 'ch1', name: 'Channel 1', logo: 'logo1.png' }
        ]);

        mockMainDb.prepare.mockImplementation((query) => {
            if (query.includes('FROM providers')) return { get: mockGetProvider };
            if (query.includes('FROM provider_channels')) return { all: mockGetChannels };
            return { run: vi.fn() };
        });

        await updateProviderEpg(providerId, true);

        // Verify fallback logic
        expect(mockGetProvider).toHaveBeenCalled();
        expect(mockGetChannels).toHaveBeenCalledWith(providerId);

        // Verify insertion into EPG DB
        const calls = mockImportDb.prepare.mock.calls.map(c => c[0]);
        const hasInsert = calls.some(sql => sql.includes('INSERT OR REPLACE INTO epg_channels'));
        expect(hasInsert).toBe(true);
    });

    it('should use importEpgFromUrl when epg_url is present', async () => {
        const providerId = 2;
        const epgUrl = 'http://example.com/xmltv';

        // Mock provider fetch
        const mockGetProvider = vi.fn().mockReturnValue({ id: providerId, epg_url: epgUrl });
        const mockGetChannels = vi.fn(); // Should not be called

        mockMainDb.prepare.mockImplementation((query) => {
            if (query.includes('FROM providers')) return { get: mockGetProvider };
            if (query.includes('FROM provider_channels')) return { all: mockGetChannels };
            return { run: vi.fn() };
        });

        await updateProviderEpg(providerId, true);

        expect(mockGetProvider).toHaveBeenCalled();
        expect(mockGetChannels).not.toHaveBeenCalled();
    });
});
