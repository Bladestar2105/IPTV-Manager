import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import db, { initDb } from '../../src/database/db.js';
import { getSettings } from '../../src/controllers/systemController.js';

describe('System Settings Controller', () => {
    beforeAll(() => {
        initDb(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        db.prepare('DELETE FROM settings').run();
    });

    it('should deny access if user is not admin', () => {
        const req = { user: { is_admin: false } };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        getSettings(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    });

    it('should return empty object if no settings exist', () => {
        const req = { user: { is_admin: true } };
        const res = {
            json: vi.fn()
        };

        getSettings(req, res);

        expect(res.json).toHaveBeenCalledWith({});
    });

    it('should return settings if they exist', () => {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('test_key', 'test_value');
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('another_key', '123');

        const req = { user: { is_admin: true } };
        const res = {
            json: vi.fn()
        };

        getSettings(req, res);

        expect(res.json).toHaveBeenCalledWith({
            test_key: 'test_value',
            another_key: '123'
        });
    });

    it('should handle database errors gracefully', () => {
        vi.spyOn(db, 'prepare').mockImplementation(() => {
            throw new Error('Database failure');
        });

        const req = { user: { is_admin: true } };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        getSettings(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Database failure' });
    });
});
