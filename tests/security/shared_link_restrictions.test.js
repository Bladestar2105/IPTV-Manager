import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import db, { initDb } from '../../src/database/db.js';
import * as hdhrController from '../../src/controllers/hdhrController.js';
import * as xtreamController from '../../src/controllers/xtreamController.js';

describe('Shared Link API Restrictions', () => {
    let sharedToken = 'share123';
    let userId;

    beforeAll(() => {
        initDb(true);
    });

    beforeEach(() => {
        // Create user
        db.prepare('INSERT OR REPLACE INTO users (username, password, hdhr_enabled, is_active) VALUES (?, ?, 1, 1)').run('shareuser', 'pass');
        const user = db.prepare('SELECT id FROM users WHERE username = ?').get('shareuser');
        userId = user.id;

        // Create shared link
        db.prepare('INSERT OR REPLACE INTO shared_links (token, user_id, channels) VALUES (?, ?, ?)').run(sharedToken, userId, '[]');
    });

    afterEach(() => {
        db.prepare('DELETE FROM shared_links WHERE token = ?').run(sharedToken);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });

    it('should block HDHR access for shared link', async () => {
        const req = {
            params: { token: sharedToken },
            query: {},
            get: (h) => h === 'host' ? 'localhost' : '',
            protocol: 'http'
        };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn(),
            send: vi.fn()
        };

        await hdhrController.discover(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: 'Access denied'
        }));
    });

    it('should block Xtream Player API for shared link', async () => {
        const req = {
            params: {},
            query: { token: sharedToken, action: 'get_live_streams' },
            get: (h) => h === 'host' ? 'localhost' : '',
            protocol: 'http'
        };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn(),
            send: vi.fn()
        };

        await xtreamController.playerApi(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            user_info: expect.objectContaining({ auth: 0, message: 'Access denied' })
        }));
    });
});
