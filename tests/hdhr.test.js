import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as hdhrController from '../src/controllers/hdhrController.js';
import db from '../src/database/db.js';
import { getXtreamUser } from '../src/services/authService.js';

// Mock dependencies
vi.mock('../src/database/db.js', () => ({
  default: {
    prepare: vi.fn(),
    exec: vi.fn(),
    pragma: vi.fn()
  }
}));

vi.mock('../src/services/authService.js', () => ({
  getXtreamUser: vi.fn()
}));

describe('HDHomeRun Controller', () => {
    let req, res;

    beforeEach(() => {
        req = {
            params: { token: 'testtoken', channelId: '1' },
            protocol: 'http',
            get: vi.fn().mockReturnValue('localhost:3000')
        };
        res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis(),
            send: vi.fn(),
            redirect: vi.fn()
        };
        vi.clearAllMocks();
    });

    describe('discover', () => {
        it('should return discovery JSON for valid enabled user', async () => {
            const user = { id: 123, username: 'user', hdhr_enabled: 1, hdhr_token: 'testtoken' };
            getXtreamUser.mockResolvedValue(user);

            await hdhrController.discover(req, res);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                FriendlyName: 'IPTV Manager (user)',
                ModelNumber: 'HDHR4-2US',
                DeviceID: expect.stringMatching(/1234[0-9a-f]+/),
                BaseURL: 'http://localhost:3000/hdhr/testtoken',
                LineupURL: 'http://localhost:3000/hdhr/testtoken/lineup.json'
            }));
        });

        it('should return 403 if user disabled', async () => {
            const user = { id: 123, username: 'user', hdhr_enabled: 0, hdhr_token: 'testtoken' };
            getXtreamUser.mockResolvedValue(user);

            await hdhrController.discover(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
        });

        it('should return 401 for invalid user', async () => {
            getXtreamUser.mockResolvedValue(null);

            await hdhrController.discover(req, res);

            expect(res.status).toHaveBeenCalledWith(401);
        });
    });

    describe('lineupStatus', () => {
        it('should return lineup status', async () => {
            getXtreamUser.mockResolvedValue({ id: 1, hdhr_enabled: 1 });

            await hdhrController.lineupStatus(req, res);

            expect(res.json).toHaveBeenCalledWith({
                ScanInProgress: 0,
                ScanPossible: 1,
                Source: "Cable",
                SourceList: ["Cable"]
            });
        });
    });

    describe('lineup', () => {
        it('should return channel lineup with token URLs (live only)', async () => {
            const user = { id: 123, username: 'user', hdhr_enabled: 1, hdhr_token: 'testtoken' };
            getXtreamUser.mockResolvedValue(user);

            const mockChannels = [
                { user_channel_id: '1', name: 'Channel 1', stream_type: 'live' },
                { user_channel_id: '3', name: 'Channel 3', stream_type: 'live' }
            ];

            // Mock DB chain: db.prepare().all()
            const mockPrepare = vi.fn().mockReturnValue({
                all: vi.fn().mockReturnValue(mockChannels)
            });
            db.prepare = mockPrepare;

            await hdhrController.lineup(req, res);

            // Verify SQL filters for live streams
            expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("pc.stream_type = 'live'"));

            expect(res.json).toHaveBeenCalledWith([
                {
                    GuideNumber: '1',
                    GuideName: 'Channel 1',
                    URL: 'http://localhost:3000/hdhr/testtoken/stream/1.ts'
                },
                {
                    GuideNumber: '2',
                    GuideName: 'Channel 3',
                    URL: 'http://localhost:3000/hdhr/testtoken/stream/3.ts'
                }
            ]);
        });
    });

    describe('auto', () => {
        it('should redirect to stream url', async () => {
            const user = { id: 123, username: 'user', hdhr_enabled: 1, hdhr_token: 'testtoken' };
            getXtreamUser.mockResolvedValue(user);

            const mockChannel = { user_channel_id: '1', stream_type: 'live' };

            // Mock DB chain: db.prepare().get()
            const mockPrepare = vi.fn().mockReturnValue({
                get: vi.fn().mockReturnValue(mockChannel)
            });
            db.prepare = mockPrepare;

            await hdhrController.auto(req, res);

            expect(res.redirect).toHaveBeenCalledWith('http://localhost:3000/hdhr/testtoken/stream/1.ts');
        });

        it('should return 404 if channel not found', async () => {
            const user = { id: 123, username: 'user', hdhr_enabled: 1 };
            getXtreamUser.mockResolvedValue(user);

            const mockPrepare = vi.fn().mockReturnValue({
                get: vi.fn().mockReturnValue(null)
            });
            db.prepare = mockPrepare;

            await hdhrController.auto(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});
