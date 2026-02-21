import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Config Constants
vi.mock('../../src/config/constants.js', () => ({
    DATA_DIR: '/tmp',
    EPG_CACHE_DIR: '/tmp/epg_cache',
    JWT_SECRET: 'testsecret'
}));

// Mock External Modules
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('jsonwebtoken', () => ({ default: { verify: vi.fn() } }));

// Mock Auth Service (to avoid bcrypt)
vi.mock('../../src/services/authService.js', () => ({
    getXtreamUser: vi.fn()
}));

// Mock DB
const mockDb = vi.hoisted(() => ({
    prepare: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn((fn) => fn),
    pragma: vi.fn()
}));

vi.mock('../../src/database/db.js', () => ({
    default: mockDb
}));

// Mock epgService
vi.mock('../../src/services/epgService.js', () => ({
    loadAllEpgChannels: vi.fn(),
    updateEpgSource: vi.fn(),
    updateProviderEpg: vi.fn(),
    deleteEpgSourceData: vi.fn(),
    getProgramsNow: vi.fn(() => []),
    getProgramsSchedule: vi.fn(() => [])
}));

import * as epgController from '../../src/controllers/epgController.js';

describe('EPG Sources Controller', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return correct last_update for providers', () => {
        const lastUpdate = 1678888888;

        const sourcesStmt = {
            all: vi.fn().mockReturnValue([])
        };

        const providerData = {
            id: 1,
            name: 'Provider 1',
            epg_url: 'http://test.com',
            epg_update_interval: 3600,
            epg_enabled: 1,
            last_epg_update: lastUpdate
        };

        const providersStmt = {
            all: vi.fn().mockReturnValue([providerData])
        };

        mockDb.prepare.mockImplementation((sql) => {
            if (sql.includes('FROM epg_sources')) return sourcesStmt;
            if (sql.includes('FROM providers')) return providersStmt;
            return { all: vi.fn().mockReturnValue([]), get: vi.fn(), run: vi.fn() };
        });

        const req = { user: { is_admin: true } };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        epgController.getEpgSources(req, res);

        expect(res.json).toHaveBeenCalled();
        const resultSources = res.json.mock.calls[0][0];

        const providerSource = resultSources.find(s => s.id === 'provider_1');
        expect(providerSource).toBeDefined();

        // This should fail currently because controller sets last_update: 0
        expect(providerSource.last_update).toBe(lastUpdate);
    });
});
