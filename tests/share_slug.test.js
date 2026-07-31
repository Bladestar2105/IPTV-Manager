
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as shareController from '../src/controllers/shareController.js';

// Hoist mockDb so it's available in the mock factory
const { mockDb } = vi.hoisted(() => {
    return {
        mockDb: {
            prepare: vi.fn(),
            exec: vi.fn()
        }
    };
});

vi.mock('../src/database/db.js', () => ({
    default: mockDb
}));

vi.mock('../src/utils/helpers.js', () => ({
    getBaseUrl: vi.fn(() => 'http://localhost:3000'),
    isUnsafeIP: vi.fn(() => false),
    isSafeUrl: vi.fn(async () => true),
    isAdultCategory: vi.fn(() => false)
}));

describe('Share Controller - Slug Generation', () => {
    let mockReq, mockRes;

    beforeEach(() => {
        vi.clearAllMocks();

        mockReq = {
            body: {},
            user: { id: 1, is_admin: true },
            get: vi.fn(),
            protocol: 'http',
            params: {}
        };
        mockRes = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis(),
            send: vi.fn(),
            redirect: vi.fn()
        };
    });

    it('should always generate a slug when name is provided', () => {
        mockReq.body = {
            channels: [1, 2, 3],
            name: 'Soccer Night'
        };

        // Mock slug check: first return undefined (no existing slug)
        const stmtMock = {
            run: vi.fn(),
            get: vi.fn().mockReturnValue(undefined)
        };
        mockDb.prepare.mockReturnValue(stmtMock);

        shareController.createShare(mockReq, mockRes);

        expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT token FROM shared_links WHERE slug = ?'));
        expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO shared_links'));

        // Check if slug was passed to INSERT
        expect(stmtMock.run).toHaveBeenCalledWith(
            expect.any(String), // token
            1, // user_id
            'Soccer Night', // name
            '[1,2,3]', // channels
            null, // start
            null, // end
            expect.stringMatching(/^soccer-night-[a-f0-9]{16}$/) // slug
        );

        expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            slug: expect.stringMatching(/^soccer-night-[a-f0-9]{16}$/),
            short_link: expect.stringMatching(/^http:\/\/localhost:3000\/share\/soccer-night-[a-f0-9]{16}$/)
        }));
    });

    it('should require a name when creating a share', () => {
        mockReq.body = {
            channels: [1]
        };

        shareController.createShare(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(400);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Name required' });
    });

    it('should handle random suffix collisions by retrying', () => {
        mockReq.body = {
            channels: [1],
            name: 'My Share'
        };

        const stmtMock = {
            run: vi.fn(),
            get: vi.fn()
                .mockReturnValueOnce({ token: 'exists' }) // First check finds duplicate
                .mockReturnValueOnce(undefined) // Second check (counter) finds none
        };
        mockDb.prepare.mockReturnValue(stmtMock);

        shareController.createShare(mockReq, mockRes);

        expect(stmtMock.run).toHaveBeenCalledWith(
            expect.any(String), 1, 'My Share', '[1]', null, null, expect.stringMatching(/^my-share-[a-f0-9]{16}$/)
        );
        expect(stmtMock.get).toHaveBeenCalledTimes(2);
        expect(stmtMock.get.mock.calls[0][0]).not.toBe(stmtMock.get.mock.calls[1][0]);
    });

    it('uses different unguessable slugs for shares with the same name', () => {
        mockReq.body = { channels: [1], name: 'Family TV' };
        const stmtMock = { run: vi.fn(), get: vi.fn().mockReturnValue(undefined) };
        mockDb.prepare.mockReturnValue(stmtMock);

        shareController.createShare(mockReq, mockRes);
        shareController.createShare(mockReq, mockRes);

        const slugs = mockRes.json.mock.calls.map(([payload]) => payload.slug);
        expect(slugs[0]).toMatch(/^family-tv-[a-f0-9]{16}$/);
        expect(slugs[1]).toMatch(/^family-tv-[a-f0-9]{16}$/);
        expect(slugs[0]).not.toBe(slugs[1]);
    });

    it('should redirect to player when accessing valid slug', () => {
        mockReq.params = { slug: 'valid-slug' };

        const stmtMock = {
            get: vi.fn().mockReturnValue({ token: 'token123' })
        };
        mockDb.prepare.mockReturnValue(stmtMock);

        shareController.handleShortLink(mockReq, mockRes);

        expect(mockRes.redirect).toHaveBeenCalledWith('http://localhost:3000/player.html?token=token123');
    });

    it('should return 404 for invalid slug', () => {
        mockReq.params = { slug: 'invalid-slug' };

        const stmtMock = {
            get: vi.fn().mockReturnValue(undefined)
        };
        mockDb.prepare.mockReturnValue(stmtMock);

        shareController.handleShortLink(mockReq, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(404);
        expect(mockRes.send).toHaveBeenCalled();
    });
});
