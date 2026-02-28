import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Ensure directory exists BEFORE imports
if (!fs.existsSync(path.join(process.cwd(), 'tests/temp_db_channel'))) fs.mkdirSync(path.join(process.cwd(), 'tests/temp_db_channel'), { recursive: true });

const TEST_DB_DIR = path.join(process.cwd(), 'tests/temp_db_channel');

// Mock Constants
vi.mock('../../src/config/constants.js', async () => {
    return {
        DATA_DIR: require('path').join(process.cwd(), 'tests/temp_db_channel'),
        PORT: 3000,
        BCRYPT_ROUNDS: 1,
        JWT_EXPIRES_IN: '1h',
        AUTH_CACHE_TTL: 60000,
        AUTH_CACHE_MAX_SIZE: 100
    };
});

// Mock Crypto
vi.mock('../../src/utils/crypto.js', () => {
    return {
        JWT_SECRET: 'test-secret',
        ENCRYPTION_KEY: 'test-key-32-bytes-length-12345678',
        encrypt: (t) => t ? `enc:${t}` : t,
        decrypt: (t) => t && t.startsWith('enc:') ? t.slice(4) : t
    };
});

// Import modules AFTER mocking
import db, { initDb } from '../../src/database/db.js';
import * as channelController from '../../src/controllers/channelController.js';

describe('Channel Controller - createUserCategory', () => {
    beforeEach(() => {
        // Clear DB
        initDb(true);
        const tables = ['users', 'user_categories', 'user_channels', 'admin_users'];
        tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run());

        // Setup initial users
        // Note: is_admin is not in users table, it's separate admin_users or managed by webui_access
        db.prepare("INSERT INTO admin_users (id, username, password, is_active) VALUES (1, 'admin', 'admin', 1)").run();
        db.prepare("INSERT INTO users (id, username, password, is_active) VALUES (2, 'user', 'user', 1)").run();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should create a category for admin themselves', async () => {
        const req = {
            params: { userId: '1' },
            body: { name: 'Admin Category', type: 'live' },
            user: { id: 1, is_admin: true }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        expect(res.json).toHaveBeenCalled();
        const response = res.json.mock.calls[0][0];
        expect(response).toHaveProperty('id');
        expect(response.is_adult).toBe(0);
        expect(response.type).toBe('live');

        const cat = db.prepare('SELECT * FROM user_categories WHERE id = ?').get(response.id);
        expect(cat.name).toBe('Admin Category');
        expect(cat.user_id).toBe(1);
    });

    it('should create a category for another user by admin', async () => {
        const req = {
            params: { userId: '2' },
            body: { name: 'User Category', type: 'vod' },
            user: { id: 1, is_admin: true }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        expect(res.json).toHaveBeenCalled();
        const response = res.json.mock.calls[0][0];
        expect(response.type).toBe('vod');

        const cat = db.prepare('SELECT * FROM user_categories WHERE id = ?').get(response.id);
        expect(cat.user_id).toBe(2);
    });

    it('should create a category for user themselves', async () => {
        const req = {
            params: { userId: '2' },
            body: { name: 'My Category' },
            user: { id: 2, is_admin: false }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        expect(res.json).toHaveBeenCalled();
        const response = res.json.mock.calls[0][0];
        expect(response.type).toBe('live'); // Default type

        const cat = db.prepare('SELECT * FROM user_categories WHERE id = ?').get(response.id);
        expect(cat.user_id).toBe(2);
        expect(cat.name).toBe('My Category');
    });

    it('should return 400 if name is missing', async () => {
        const req = {
            params: { userId: '1' },
            body: { type: 'live' },
            user: { id: 1, is_admin: true }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'name required' });
    });

    it('should return 403 if non-admin tries to create category for another user', async () => {
        const req = {
            params: { userId: '1' },
            body: { name: 'Steal Category' },
            user: { id: 2, is_admin: false }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    });

    it('should detect adult category based on name', async () => {
        const req = {
            params: { userId: '1' },
            body: { name: 'My XXX Category' },
            user: { id: 1, is_admin: true }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        expect(res.json).toHaveBeenCalled();
        const response = res.json.mock.calls[0][0];
        expect(response.is_adult).toBe(1);

        const cat = db.prepare('SELECT * FROM user_categories WHERE id = ?').get(response.id);
        expect(cat.is_adult).toBe(1);
    });

    it('should calculate correct sort_order', async () => {
        // Insert existing category
        db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (1, 'Cat 1', 5)").run();

        const req = {
            params: { userId: '1' },
            body: { name: 'Cat 2' },
            user: { id: 1, is_admin: true }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        const response = res.json.mock.calls[0][0];
        const cat = db.prepare('SELECT * FROM user_categories WHERE id = ?').get(response.id);
        expect(cat.sort_order).toBe(6);
    });

    it('should handle database errors', async () => {
        vi.spyOn(db, 'prepare').mockImplementation(() => {
            throw new Error('DB Error');
        });

        const req = {
            params: { userId: '1' },
            body: { name: 'Faulty Category' },
            user: { id: 1, is_admin: true }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'DB Error' });
    });
});
