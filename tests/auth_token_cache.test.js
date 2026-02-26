
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getXtreamUser, tokenCache } from '../src/services/authService.js';
import db from '../src/database/db.js';

describe('Auth Service Token Caching', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        if (tokenCache) tokenCache.clear();
    });

    it('should cache token lookups to avoid DB hits', async () => {
        const token = 'test_token_cache_123';
        const user = { id: 1, username: 'testuser', is_active: 1 };

        // Mock DB responses
        const prepareSpy = vi.spyOn(db, 'prepare');

        // Chain mocks: db.prepare().get()
        const getMockToken = vi.fn().mockReturnValue({ user_id: 1, session_id: null }); // Found in temporary_tokens
        const getMockUser = vi.fn().mockReturnValue(user); // Found user

        prepareSpy.mockImplementation((query) => {
            if (query.includes('temporary_tokens')) return { get: getMockToken };
            if (query.includes('FROM users')) return { get: getMockUser };
            return { get: vi.fn(), run: vi.fn() }; // Default
        });

        const req = { query: { token }, params: {} };

        // 1. First Call - Should hit DB
        const result1 = await getXtreamUser(req);

        expect(result1).toEqual(user);
        expect(prepareSpy).toHaveBeenCalledTimes(2); // 1 for token, 1 for user

        // Clear mock calls to reset call count
        prepareSpy.mockClear();

        // 2. Second Call - Should hit Cache (NOT DB)
        const result2 = await getXtreamUser(req);

        expect(result2).toEqual(user);

        // This expectation is the key: currently it will fail because prepareSpy IS called
        // After optimization, it should be 0
        expect(prepareSpy).toHaveBeenCalledTimes(0);
    });
});
