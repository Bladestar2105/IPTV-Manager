import { describe, it, expect, beforeAll, vi } from 'vitest';
import db, { initDb } from '../src/database/db.js';
import * as userController from '../src/controllers/userController.js';

describe('User Deletion Regression', () => {
    beforeAll(() => {
        initDb(true);
    });

    it('should successfully delete a user with temporary tokens', () => {
        // Create user
        const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('testuser_fixed', 'password');
        const userId = info.lastInsertRowid;

        // Create temporary token
        db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run('token123_fixed', userId, Math.floor(Date.now() / 1000) + 10000);

        // Mock req and res
        const req = {
            user: { is_admin: true },
            params: { id: userId }
        };

        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        // Call controller
        userController.deleteUser(req, res);

        // Assert success
        // If it failed, res.status(500).json(...) would have been called.
        // We verify that res.json was called with {success: true}
        expect(res.json).toHaveBeenCalledWith({ success: true });

        // Assert user is gone
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        expect(user).toBeUndefined();

        // Assert token is gone
        const token = db.prepare('SELECT * FROM temporary_tokens WHERE user_id = ?').get(userId);
        expect(token).toBeUndefined();
    });
});
