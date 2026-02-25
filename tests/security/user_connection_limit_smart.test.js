
import { describe, it, expect, vi, beforeEach } from 'vitest';
import streamManager from '../../src/services/streamManager.js';

describe('Smart Stream Counting Logic', () => {
    let mockDb;
    let mockPrepare;

    beforeEach(() => {
        vi.clearAllMocks();
        mockPrepare = vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() }));
        mockDb = { prepare: mockPrepare };

        // Reset streamManager internal state
        streamManager.db = null;
        streamManager.redis = null;
        streamManager.stmtCountUser = null;
        streamManager.stmtAdd = null;
        streamManager.stmtRemove = null;
        streamManager.stmtCleanup = null;
        streamManager.stmtGetAll = null;
        streamManager.stmtCountProvider = null;
    });

    it('should use DISTINCT query for user connection count in SQLite mode', () => {
        streamManager.init(mockDb, null);

        // Check calls to prepare
        const calls = mockPrepare.mock.calls.map(c => c[0]);
        // We look for the query that counts user streams
        const countQuery = calls.find(sql => sql.includes('SELECT COUNT(*) as count FROM') && sql.includes('user_id = ?'));

        expect(countQuery).toBeDefined();
        // This expectation will fail BEFORE the fix, confirming reproduction
        // We expect it to count distinct sessions
        expect(countQuery).toContain('DISTINCT channel_name, ip, provider_id');
    });

    it('should filter unique sessions correctly in Redis mode', async () => {
        const mockRedis = {
            hSet: vi.fn(),
            set: vi.fn(),
            hGetAll: vi.fn().mockResolvedValue({
                'conn1': JSON.stringify({ user_id: 1, channel_name: 'Movie A', ip: '1.2.3.4', provider_id: 100 }),
                'conn2': JSON.stringify({ user_id: 1, channel_name: 'Movie A', ip: '1.2.3.4', provider_id: 100 }), // Duplicate session (same user, movie, ip)
                'conn3': JSON.stringify({ user_id: 1, channel_name: 'Movie B', ip: '1.2.3.4', provider_id: 100 }), // Different movie
                'conn4': JSON.stringify({ user_id: 2, channel_name: 'Movie A', ip: '1.2.3.4', provider_id: 100 }), // Different user
                'conn5': JSON.stringify({ user_id: 1, channel_name: 'Movie A', ip: '5.6.7.8', provider_id: 100 }), // Different IP
            }),
            on: vi.fn(),
            connect: vi.fn()
        };

        streamManager.init(null, mockRedis);

        const count = await streamManager.getUserConnectionCount(1);

        // Expected unique sessions for user 1:
        // 1. (Movie A, 1.2.3.4, 100) - from conn1 and conn2
        // 2. (Movie B, 1.2.3.4, 100) - from conn3
        // 3. (Movie A, 5.6.7.8, 100) - from conn5
        // Total: 3

        // Before fix: returns 4 (conn1, conn2, conn3, conn5).
        // After fix: returns 3.

        expect(count).toBe(3);
    });
});
