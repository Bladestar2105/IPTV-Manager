import { describe, it, expect, beforeAll, vi } from 'vitest';
import db, { initDb } from '../src/database/db.js';
import * as providerController from '../src/controllers/providerController.js';
import { encrypt } from '../src/utils/crypto.js';

describe('Provider Password Visibility', () => {
    beforeAll(() => {
        initDb(true);
        // Clean up tables to avoid conflicts
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();
    });

    it('should return plain_password for admin', () => {
        // Create user (admin)
        const userInfo = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('adminuser', 'password');
        const userId = userInfo.lastInsertRowid;
        // We mock req.user, so no need to insert into admin_users table for this test

        // Create provider
        const password = 'secret_password_123';
        const encryptedPassword = encrypt(password);
        const providerInfo = db.prepare('INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('TestProvider', 'http://test.com', 'testuser', encryptedPassword, null, userId, 86400, 1);
        const providerId = providerInfo.lastInsertRowid;

        // Mock req and res for Admin
        const req = {
            user: { id: userId, is_admin: true },
            query: {}
        };

        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        // Call controller
        providerController.getProviders(req, res);

        // Assert
        expect(res.json).toHaveBeenCalled();
        const responseData = res.json.mock.calls[0][0];
        const provider = responseData.find(p => p.id === providerId);

        expect(provider).toBeDefined();
        expect(provider.password).toBe('********');
        expect(provider.plain_password).toBe(password);
    });

    it('should NOT return plain_password for non-admin', () => {
         // Create user (non-admin)
         const userInfo = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('regularuser', 'password');
         const userId = userInfo.lastInsertRowid;

         // Create provider (owned by this user)
         const password = 'secret_password_456';
         const encryptedPassword = encrypt(password);
         const providerInfo = db.prepare('INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('UserProvider', 'http://user-test.com', 'user', encryptedPassword, null, userId, 86400, 1);
         const providerId = providerInfo.lastInsertRowid;

         // Mock req and res for Non-Admin
         const req = {
             user: { id: userId, is_admin: false },
             query: {}
         };

         const res = {
             status: vi.fn().mockReturnThis(),
             json: vi.fn()
         };

         // Call controller
         providerController.getProviders(req, res);

         // Assert
         expect(res.json).toHaveBeenCalled();
         const responseData = res.json.mock.calls[0][0];
         const provider = responseData.find(p => p.id === providerId);

         expect(provider).toBeDefined();
         expect(provider.password).toBe('********');
         expect(provider.plain_password).toBe('********');
    });
});
