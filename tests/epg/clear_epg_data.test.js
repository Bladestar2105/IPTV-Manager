import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mock variables are available for mocking
const { mockEpgDb } = vi.hoisted(() => {
    return {
        mockEpgDb: {
            prepare: vi.fn(),
            transaction: vi.fn((cb) => {
                // Return a function that executes the callback
                return (...args) => cb(...args);
            }),
        },
    };
});

vi.mock('../../src/database/epgDb.js', () => ({
    default: mockEpgDb,
}));

const { mockMainDb } = vi.hoisted(() => {
    return {
        mockMainDb: {
            prepare: vi.fn(),
        },
    };
});

// Mock mainDb as it's also imported
vi.mock('../../src/database/db.js', () => ({
    default: mockMainDb,
}));

// Mock other dependencies to avoid side effects during import
vi.mock('../../src/utils/network.js', () => ({
    fetchSafe: vi.fn(),
}));

vi.mock('node-xml-stream', () => {
    return {
        default: vi.fn().mockImplementation(() => ({
            on: vi.fn(),
        })),
    };
});

vi.mock('better-sqlite3', () => {
    return {
        default: vi.fn().mockImplementation(() => ({
            pragma: vi.fn(),
            prepare: vi.fn(),
            transaction: vi.fn(cb => cb),
            close: vi.fn()
        }))
    };
});

import { clearEpgData } from '../../src/services/epgService.js';

describe('clearEpgData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should clear epg_programs and epg_channels within a transaction, and reset epg_sources', () => {
        const mockRun = vi.fn();
        mockEpgDb.prepare.mockReturnValue({ run: mockRun });
        mockMainDb.prepare.mockReturnValue({ run: mockRun });

        clearEpgData();

        // Verify transaction was created and called
        expect(mockEpgDb.transaction).toHaveBeenCalled();

        // Verify tables are deleted in epgDb
        expect(mockEpgDb.prepare).toHaveBeenCalledWith('DELETE FROM epg_programs');
        expect(mockEpgDb.prepare).toHaveBeenCalledWith('DELETE FROM epg_channels');

        // Verify epg_sources status is reset in mainDb
        expect(mockMainDb.prepare).toHaveBeenCalledWith('UPDATE epg_sources SET last_update = 0, is_updating = 0');

        // Verify run was called for all three commands
        expect(mockRun).toHaveBeenCalledTimes(3);
    });

    it('should propagate errors if database operation fails', () => {
        mockEpgDb.prepare.mockImplementation(() => {
            throw new Error('Database error');
        });

        expect(() => clearEpgData()).toThrow('Database error');
    });

    it('should propagate errors if transaction fails', () => {
        mockEpgDb.transaction.mockImplementation(() => {
            return () => {
                throw new Error('Transaction failed');
            };
        });

        expect(() => clearEpgData()).toThrow('Transaction failed');
    });
});
