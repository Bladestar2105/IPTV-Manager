import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import db, { initDb } from '../../src/database/db.js';
import * as userController from '../../src/controllers/userController.js';

describe('User Admin Username Collision', () => {
    beforeAll(() => {
        initDb(true);
        // Create an admin user
        db.prepare('INSERT OR IGNORE INTO admin_users (username, password) VALUES (?, ?)').run('admin', 'adminpass');
    });

    afterEach(() => {
        // Clean up test users
        db.prepare('DELETE FROM users WHERE username = ?').run('admin');
        db.prepare('DELETE FROM users WHERE username = ?').run('testuser');
    });

    it('should fail to create a user with the same username as an admin', async () => {
        const req = {
            user: { is_admin: true },
            body: {
                username: 'admin',
                password: 'password123',
                webui_access: true
            }
        };

        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        await userController.createUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: 'username_taken'
        }));
    });

    it('should fail to update a user to the same username as an admin', async () => {
        // Create a normal user first
        const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('testuser', 'password');
        const userId = info.lastInsertRowid;

        const req = {
            user: { is_admin: true },
            params: { id: userId },
            body: {
                username: 'admin'
            }
        };

        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        await userController.updateUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: 'username_taken'
        }));
    });
});
