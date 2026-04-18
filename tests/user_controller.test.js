import { describe, it, expect, beforeAll, vi } from 'vitest';
import db, { initDb } from '../src/database/db.js';
import * as userController from '../src/controllers/userController.js';
import { encrypt } from '../src/utils/crypto.js';

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

describe('User credential visibility for admins', () => {
    beforeAll(() => {
        initDb(true);
    });

    it('should return decrypted plain_password for admin requests', () => {
        const encryptedPlain = encrypt('visible_for_admin');
        db.prepare('INSERT INTO users (username, password, plain_password, is_active) VALUES (?, ?, ?, 1)')
            .run(`admin_plain_pw_${Date.now()}`, 'hashedpw', encryptedPlain);

        const req = {
            user: { is_admin: true }
        };

        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        userController.getUsers(req, res);

        const payload = res.json.mock.calls[0]?.[0] || [];
        const found = payload.find(u => u.plain_password === 'visible_for_admin');
        expect(found).toBeTruthy();
    });
});
