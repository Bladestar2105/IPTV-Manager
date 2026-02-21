import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as userController from '../../src/controllers/userController.js';
import db from '../../src/database/db.js';

// Mock database
vi.mock('../../src/database/db.js', () => ({
    default: {
        prepare: vi.fn(),
        transaction: vi.fn((cb) => cb())
    }
}));

// Mock crypto/bcrypt
vi.mock('../../src/utils/crypto.js', () => ({
    encrypt: vi.fn(val => val),
    decrypt: vi.fn(val => val)
}));
vi.mock('bcrypt', () => ({
    default: {
        hash: vi.fn().mockResolvedValue('hashed_pass')
    }
}));

describe('Admin Isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should prevent creating a user with username "admin" if reserved', async () => {
        const req = {
            user: { is_admin: 1 },
            body: { username: 'admin', password: 'password123' }
        };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        // Mock DB responses
        db.prepare.mockImplementation((query) => {
            if (query.includes('FROM users WHERE username')) {
                return { get: vi.fn().mockReturnValue(null) }; // Not in users
            }
            if (query.includes('FROM admin_users WHERE username')) {
                return { get: vi.fn().mockReturnValue({ id: 1 }) }; // FOUND in admin_users
            }
            return { run: vi.fn(), get: vi.fn() };
        });

        await userController.createUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: 'username_taken'
        }));
    });

    it('should prevent renaming a user to an existing admin username', async () => {
        const req = {
            user: { is_admin: 1 },
            params: { id: 2 },
            body: { username: 'admin' }
        };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        // Mock DB responses
        db.prepare.mockImplementation((query) => {
            if (query.includes('SELECT * FROM users WHERE id')) {
                return { get: vi.fn().mockReturnValue({ id: 2, username: 'testuser' }) };
            }
            if (query.includes('FROM users WHERE username')) {
                return { get: vi.fn().mockReturnValue(null) };
            }
            if (query.includes('FROM admin_users WHERE username')) {
                return { get: vi.fn().mockReturnValue({ id: 1 }) }; // Found
            }
            return { run: vi.fn(), get: vi.fn() };
        });

        await userController.updateUser(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: 'username_taken'
        }));
    });

    it('getUsers should only select from users table', () => {
        const req = { user: { is_admin: 1 } };
        const res = { json: vi.fn() };

        db.prepare.mockImplementation((query) => {
            if (query.includes('FROM users ORDER BY id')) {
                return { all: vi.fn().mockReturnValue([]) };
            }
            return { all: vi.fn() };
        });

        userController.getUsers(req, res);

        // Verify the query did not include admin_users
        // This is a bit weak since we mock `db.prepare`, but we check the call arg
        const calls = db.prepare.mock.calls;
        const query = calls[0][0];
        expect(query).toContain('FROM users');
        expect(query).not.toContain('admin_users');
    });
});
