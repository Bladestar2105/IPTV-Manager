import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the databases before importing the service
vi.mock('../../src/database/epgDb.js', () => ({
    default: {
        prepare: vi.fn()
    }
}));

vi.mock('../../src/database/db.js', () => ({
    default: {
        prepare: vi.fn()
    }
}));

// Mock other dependencies if necessary
vi.mock('../../src/utils/network.js', () => ({
    fetchSafe: vi.fn()
}));

import { getLastEpgUpdate } from '../../src/services/epgService.js';
import db from '../../src/database/epgDb.js';

describe('epgService - getLastEpgUpdate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return the last update time when data exists', () => {
        const mockRow = { last_update: 123456789 };
        const mockGet = vi.fn().mockReturnValue(mockRow);
        db.prepare.mockReturnValue({ get: mockGet });

        const result = getLastEpgUpdate('custom', 1);

        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT MAX(updated_at)'));
        expect(mockGet).toHaveBeenCalledWith('custom', 1);
        expect(result).toBe(123456789);
    });

    it('should return 0 when no data is found (row.last_update is null)', () => {
        // In SQLite, MAX() on an empty set returns NULL
        const mockRow = { last_update: null };
        const mockGet = vi.fn().mockReturnValue(mockRow);
        db.prepare.mockReturnValue({ get: mockGet });

        const result = getLastEpgUpdate('custom', 1);

        expect(result).toBe(0);
    });

    it('should return 0 when row.last_update is 0', () => {
        const mockRow = { last_update: 0 };
        const mockGet = vi.fn().mockReturnValue(mockRow);
        db.prepare.mockReturnValue({ get: mockGet });

        const result = getLastEpgUpdate('custom', 1);

        expect(result).toBe(0);
    });

    it('should return 0 when row is undefined', () => {
        const mockGet = vi.fn().mockReturnValue(undefined);
        db.prepare.mockReturnValue({ get: mockGet });

        const result = getLastEpgUpdate('custom', 1);

        expect(result).toBe(0);
    });
});
