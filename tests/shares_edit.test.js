import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrepare, mockRun, mockGet, mockAll } = vi.hoisted(() => {
    const mockRun = vi.fn();
    const mockGet = vi.fn();
    const mockAll = vi.fn();
    const mockPrepare = vi.fn(() => ({
        run: mockRun,
        get: mockGet,
        all: mockAll
    }));
    return { mockPrepare, mockRun, mockGet, mockAll };
});

vi.mock('../src/database/db.js', () => ({
    default: {
        prepare: mockPrepare
    }
}));

import { updateShare } from '../src/controllers/shareController.js';

describe('Share Controller - updateShare', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should update share successfully', () => {
        const req = {
            params: { token: 'test-token' },
            body: {
                name: 'Updated Name',
                channels: [1, 2, 3],
                start_time: '2023-01-01T00:00:00.000Z',
                end_time: '2023-01-02T00:00:00.000Z'
            },
            user: { id: 1, is_admin: false }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn(() => res)
        };

        mockRun.mockReturnValue({ changes: 1 });

        updateShare(req, res);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE shared_links'));
        expect(mockRun).toHaveBeenCalledWith(
            JSON.stringify([1, 2, 3]),
            'Updated Name',
            1672531200,
            1672617600,
            'test-token',
            1
        );
        expect(res.json).toHaveBeenCalledWith({ success: true, token: 'test-token' });
    });

    it('should return 404 if share not found', () => {
        const req = {
            params: { token: 'test-token' },
            body: { channels: [1] },
            user: { id: 1, is_admin: false }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn(() => res)
        };

        mockRun.mockReturnValue({ changes: 0 });

        updateShare(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Share not found' });
    });
});
