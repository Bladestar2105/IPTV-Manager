
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/database/db.js', () => ({
    default: {
        prepare: vi.fn(),
    }
}));

import { getXtreamUser, tokenCache } from '../src/services/authService.js';
import db from '../src/database/db.js';

describe('Auth Service Token Caching', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        if (tokenCache) tokenCache.clear();
    });

    it('caches credential lookup while revalidating current account access', async () => {
        const token = 'test_token_cache_123';
        const user = { id: 1, username: 'testuser', is_active: 1 };
        const getMockToken = vi.fn().mockReturnValue({ user_id: 1, session_id: null, expires_at: Date.now() / 1000 + 3600 });
        const getMockUser = vi.fn().mockReturnValue(user);
        db.prepare.mockImplementation(query => {
            if (query.includes('temporary_tokens')) return { get: getMockToken };
            if (query.includes('FROM users')) return { get: getMockUser };
            return { get: vi.fn(), run: vi.fn() };
        });
        const req = { query: { token }, params: {} };
        expect(await getXtreamUser(req)).toEqual(user);
        expect(await getXtreamUser(req)).toEqual(user);
        expect(getMockToken).toHaveBeenCalledTimes(1);
        expect(getMockUser).toHaveBeenCalledTimes(3);
        getMockUser.mockReturnValue(undefined);
        expect(await getXtreamUser(req)).toBeNull();
    });
    it('can revalidate a resource source token after a share edit or deletion', async () => {
        const req = { query: { token: 'share-token' }, params: {} };
        const cachedUser = { id: 1, username: 'testuser', is_active: 1, is_share_guest: true, allowed_channels: [5] };
        tokenCache.set(req.query.token, { user: cachedUser, expiry: Date.now() + 60000 });
        let share = { user_id: 1, channels: '[6]' };
        db.prepare.mockImplementation(sql => ({ get: () => {
            if (sql.includes('shared_links')) return share;
            if (sql.includes('FROM users')) return { id: 1, username: 'testuser', is_active: 1 };
        } }));
        expect((await getXtreamUser(req, { fresh: true })).allowed_channels).toEqual([6]);
        share = null;
        expect(await getXtreamUser(req, { fresh: true })).toBeNull();
    });
});
