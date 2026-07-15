import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Ensure directory exists BEFORE imports
if (!fs.existsSync(path.join(process.cwd(), 'tests/temp_db_channel'))) fs.mkdirSync(path.join(process.cwd(), 'tests/temp_db_channel'), { recursive: true });

const TEST_DB_DIR = path.join(process.cwd(), 'tests/temp_db_channel');

// Mock Constants
vi.mock('../../src/config/constants.js', async () => {
    const path = require('path');
    const testDir = path.join(process.cwd(), 'tests/temp_db_channel');
    return {
        DATA_DIR: testDir,
        EPG_DB_PATH: path.join(testDir, 'epg.db'),
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
        const tables = ['user_channels', 'user_categories', 'provider_channels', 'providers', 'users', 'admin_users'];
        db.pragma('foreign_keys = OFF');
        tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run());
        db.pragma('foreign_keys = ON');

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
            user: { id: 1, is_admin: true, username: 'admin' },
            ip: '127.0.0.1'
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
            user: { id: 1, is_admin: true, username: 'admin' },
            ip: '127.0.0.1'
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
            user: { id: 2, is_admin: false, username: 'user' },
            ip: '127.0.0.1'
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
            user: { id: 1, is_admin: true, username: 'admin' },
            ip: '127.0.0.1'
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
            user: { id: 2, is_admin: false, username: 'user' },
            ip: '127.0.0.1'
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
            user: { id: 1, is_admin: true, username: 'admin' },
            ip: '127.0.0.1'
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
        db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (1, 'Cat 1', 0)").run();

        const req = {
            params: { userId: '1' },
            body: { name: 'Cat 2' },
            user: { id: 1, is_admin: true, username: 'admin' },
            ip: '127.0.0.1'
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        channelController.createUserCategory(req, res);

        const response = res.json.mock.calls[0][0];
        const cat = db.prepare('SELECT * FROM user_categories WHERE id = ?').get(response.id);
        expect(cat.sort_order).toBe(1);
    });

    it('should reject channels owned by another user', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'My Category')").run().lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Admin Provider', 'http://provider.test', 'u', 'p', 1)").run().lastInsertRowid;
        const channelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, 100, 'Foreign Channel')").run(providerId).lastInsertRowid;
        const req = {
            params: { catId: String(categoryId) },
            body: { provider_channel_id: channelId },
            user: { id: 2, is_admin: false }
        };
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.addUserChannel(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
        expect(db.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
    });

    it('should allow admins to assign channels across users', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'Managed Category')").run().lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Admin Provider', 'http://provider.test', 'u', 'p', 1)").run().lastInsertRowid;
        const channelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, 100, 'Managed Channel')").run(providerId).lastInsertRowid;
        const req = {
            params: { catId: String(categoryId) },
            body: { provider_channel_id: channelId },
            user: { id: 1, is_admin: true }
        };
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.addUserChannel(req, res);

        expect(res.status).not.toHaveBeenCalled();
        expect(db.prepare('SELECT provider_channel_id FROM user_channels WHERE id = ?').get(res.json.mock.calls[0][0].id).provider_channel_id).toBe(channelId);
    });

    it('should add an owned channel after an existing zero sort order', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'My Category')").run().lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('My Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const firstChannelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, 100, 'First Channel')").run(providerId).lastInsertRowid;
        const secondChannelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, 101, 'Second Channel')").run(providerId).lastInsertRowid;
        db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, 0)').run(categoryId, firstChannelId);
        const req = {
            params: { catId: String(categoryId) },
            body: { provider_channel_id: secondChannelId },
            user: { id: 2, is_admin: false }
        };
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.addUserChannel(req, res);

        expect(res.status).not.toHaveBeenCalled();
        const created = db.prepare('SELECT * FROM user_channels WHERE id = ?').get(res.json.mock.calls[0][0].id);
        expect(created.sort_order).toBe(1);
    });

    it('should handle database errors', async () => {
        vi.spyOn(db, 'prepare').mockImplementation(() => {
            throw new Error('DB Error');
        });

        const req = {
            params: { userId: '1' },
            body: { name: 'Faulty Category' },
            user: { id: 1, is_admin: true, username: 'admin' },
            ip: '127.0.0.1'
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
