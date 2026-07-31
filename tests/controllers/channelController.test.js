import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';

const { TEST_DB_DIR } = vi.hoisted(() => {
    const fsModule = require('fs');
    const osModule = require('os');
    const pathModule = require('path');
    return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-channel-controller-')) };
});

// Mock Constants
vi.mock('../../src/config/constants.js', async () => {
    const path = require('path');
    return {
        DATA_DIR: TEST_DB_DIR,
        EPG_DB_PATH: path.join(TEST_DB_DIR, 'epg.db'),
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
import { channelsJsonCache } from '../../src/services/cacheService.js';

describe('Channel Controller - createUserCategory', () => {
    afterAll(() => {
        db.close();
        fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    });

    beforeEach(() => {
        // Clear DB
        initDb(true);
        const tables = ['user_channels', 'category_mappings', 'user_categories', 'provider_channels', 'providers', 'users', 'admin_users'];
        db.pragma('foreign_keys = OFF');
        tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run());
        db.pragma('foreign_keys = ON');

        // Setup initial users
        // Note: is_admin is not in users table, it's separate admin_users or managed by webui_access
        db.prepare("INSERT INTO admin_users (id, username, password, is_active) VALUES (1, 'admin', 'admin', 1)").run();
        db.prepare("INSERT INTO users (id, username, password, is_active) VALUES (2, 'user', 'user', 1)").run();
        db.prepare("INSERT INTO users (id, username, password, is_active) VALUES (3, 'other', 'other', 1)").run();
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
        const created = db.prepare('SELECT * FROM user_channels WHERE id = ?').get(res.json.mock.calls[0][0].id);
        expect(created.provider_channel_id).toBe(channelId);
        expect(created.granted_by_admin).toBe(1);
        expect(created.authorization_revoked).toBe(0);
        expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = ?').get(created.id).id).toBe(created.id);
    });

    it('should mark same-owner assignments as normal and playable', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'My Category')").run().lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('My Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const channelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, 100, 'My Channel')").run(providerId).lastInsertRowid;
        const req = {
            params: { catId: String(categoryId) },
            body: { provider_channel_id: channelId },
            user: { id: 2, is_admin: false }
        };
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.addUserChannel(req, res);

        const created = db.prepare('SELECT * FROM user_channels WHERE id = ?').get(res.json.mock.calls[0][0].id);
        expect(created.granted_by_admin).toBe(0);
        expect(created.authorization_revoked).toBe(0);
        expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = ?').get(created.id).id).toBe(created.id);
    });

    it('transfers a mapped assignment to manual ownership when re-added', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Mapped', 'live')").run().lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Mapped Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const channelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, 100, 'Mapped Channel', 'live')").run(providerId).lastInsertRowid;
        const mappingId = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
          VALUES (?, 2, 100, 'Mapped', ?, 'live')
        `).run(providerId, categoryId).lastInsertRowid;
        const assignmentId = db.prepare(`
          INSERT INTO user_channels
            (user_category_id, provider_channel_id, is_hidden, assignment_origin, mapping_id)
          VALUES (?, ?, 1, 'mapping', ?)
        `).run(categoryId, channelId, mappingId).lastInsertRowid;

        const addRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
        channelController.addUserChannel({
            params: { catId: String(categoryId) },
            body: { provider_channel_id: channelId },
            user: { id: 2, is_admin: false }
        }, addRes);

        expect(addRes.json).toHaveBeenCalledWith({ id: assignmentId });
        expect(db.prepare('SELECT assignment_origin, mapping_id, is_hidden FROM user_channels WHERE id = ?').get(assignmentId))
          .toEqual({ assignment_origin: 'manual', mapping_id: null, is_hidden: 0 });

        const unmapRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
        channelController.updateCategoryMapping({
            params: { id: String(mappingId) }, body: { user_category_id: null },
            user: { id: 2, is_admin: false }
        }, unmapRes);

        expect(db.prepare('SELECT id, assignment_origin, mapping_id FROM user_channels WHERE id = ?').get(assignmentId))
          .toEqual({ id: assignmentId, assignment_origin: 'manual', mapping_id: null });
    });

    it('should return 404 for an unknown provider channel', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'My Category')").run().lastInsertRowid;
        const req = {
            params: { catId: String(categoryId) },
            body: { provider_channel_id: 999999 },
            user: { id: 2, is_admin: false }
        };
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.addUserChannel(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Channel not found' });
    });

    it('should only restore a hidden cross-owner row as an explicit admin grant', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'Managed Category')").run().lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Foreign Provider', 'http://provider.test', 'u', 'p', 1)").run().lastInsertRowid;
        const channelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, 100, 'Foreign Channel')").run(providerId).lastInsertRowid;
        const assignmentId = db.prepare(`
          INSERT INTO user_channels
            (user_category_id, provider_channel_id, sort_order, is_hidden, authorization_revoked)
          VALUES (?, ?, 0, 1, 1)
        `).run(categoryId, channelId).lastInsertRowid;
        const body = { provider_channel_id: channelId };

        const userRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
        channelController.addUserChannel({ params: { catId: String(categoryId) }, body, user: { id: 2, is_admin: false } }, userRes);
        expect(userRes.status).toHaveBeenCalledWith(403);
        expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = ?').get(assignmentId)).toEqual({
          is_hidden: 1, granted_by_admin: 0, authorization_revoked: 1
        });

        const adminRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
        channelController.addUserChannel({ params: { catId: String(categoryId) }, body, user: { id: 1, is_admin: true } }, adminRes);
        expect(adminRes.json).toHaveBeenCalledWith({ id: assignmentId });
        expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = ?').get(assignmentId)).toEqual({
          is_hidden: 0, granted_by_admin: 1, authorization_revoked: 0
        });
    });

    it('should exclude an ungranted legacy mismatch from category lists', () => {
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'My Category')").run().lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Foreign Provider', 'http://provider.test', 'u', 'p', 1)").run().lastInsertRowid;
        const channelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, 100, 'Foreign Channel')").run(providerId).lastInsertRowid;
        db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, 0)').run(categoryId, channelId);
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.getCategoryChannels({ params: { catId: String(categoryId) }, user: { id: 1, is_admin: true } }, res);

        expect(res.json).toHaveBeenCalledWith([]);
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
        expect(created.granted_by_admin).toBe(0);
    });

    it('reorders only categories owned by the route user', () => {
        const first = db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (2, 'First', 10)").run().lastInsertRowid;
        const second = db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (2, 'Second', 20)").run().lastInsertRowid;
        const foreign = db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (3, 'Foreign', 30)").run().lastInsertRowid;
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.reorderUserCategories({
            params: { userId: '2' },
            body: { category_ids: [String(second), first] },
            user: { id: 2, is_admin: false }
        }, res);

        expect(res.json).toHaveBeenCalledWith({ success: true });
        expect(db.prepare('SELECT id, sort_order FROM user_categories ORDER BY id').all()).toEqual([
            { id: first, sort_order: 1 },
            { id: second, sort_order: 0 },
            { id: foreign, sort_order: 30 }
        ]);
    });

    it.each([
        ['a foreign ID', 'foreign', false],
        ['mixed own and foreign IDs', 'mixed', false],
        ['an unknown ID', 'unknown', false],
        ['a malformed ID', 'malformed', false],
        ['duplicate IDs', 'duplicate', false],
        ['an admin request containing a foreign ID', 'mixed', true]
    ])('rejects category reorder with %s without partial writes', (_label, kind, isAdmin) => {
        const first = db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (2, 'First', 10)").run().lastInsertRowid;
        const second = db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (2, 'Second', 20)").run().lastInsertRowid;
        const foreign = db.prepare("INSERT INTO user_categories (user_id, name, sort_order) VALUES (3, 'Foreign', 30)").run().lastInsertRowid;
        const submitted = {
            foreign: [foreign],
            mixed: [second, foreign],
            unknown: [second, 999999],
            malformed: [second, 'not-an-id'],
            duplicate: [first, String(first)]
        }[kind];
        const before = db.prepare('SELECT id, sort_order FROM user_categories ORDER BY id').all();
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.reorderUserCategories({
            params: { userId: '2' },
            body: { category_ids: submitted },
            user: isAdmin ? { id: 1, is_admin: true } : { id: 2, is_admin: false }
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(db.prepare('SELECT id, sort_order FROM user_categories ORDER BY id').all()).toEqual(before);
    });

    it('reorders only assignments in the route category', () => {
        const category = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'Live')").run().lastInsertRowid;
        const otherCategory = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'Other')").run().lastInsertRowid;
        const foreignCategory = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (3, 'Foreign')").run().lastInsertRowid;
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const addAssignment = (catId, remoteId, sortOrder) => {
            const providerChannel = db.prepare('INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, ?, ?)')
                .run(provider, remoteId, `Channel ${remoteId}`).lastInsertRowid;
            return db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)')
                .run(catId, providerChannel, sortOrder).lastInsertRowid;
        };
        const first = addAssignment(category, 101, 10);
        const second = addAssignment(category, 102, 20);
        const other = addAssignment(otherCategory, 103, 30);
        const foreign = addAssignment(foreignCategory, 104, 40);
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.reorderUserChannels({
            params: { catId: String(category) },
            body: { channel_ids: [second, String(first)] },
            user: { id: 2, is_admin: false }
        }, res);

        expect(res.json).toHaveBeenCalledWith({ success: true });
        expect(db.prepare('SELECT id, sort_order FROM user_channels ORDER BY id').all()).toEqual([
            { id: first, sort_order: 1 },
            { id: second, sort_order: 0 },
            { id: other, sort_order: 30 },
            { id: foreign, sort_order: 40 }
        ]);
    });

    it.each([
        ['another category of the same user', 'other', false],
        ['a foreign user assignment', 'foreign', false],
        ['mixed valid and other-category IDs', 'mixed', false],
        ['an unknown ID', 'unknown', false],
        ['a malformed ID', 'malformed', false],
        ['duplicate IDs', 'duplicate', false],
        ['an admin request containing an out-of-category ID', 'mixed', true]
    ])('rejects channel reorder with %s without partial writes', (_label, kind, isAdmin) => {
        const category = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'Live')").run().lastInsertRowid;
        const otherCategory = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'Other')").run().lastInsertRowid;
        const foreignCategory = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (3, 'Foreign')").run().lastInsertRowid;
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const addAssignment = (catId, remoteId, sortOrder) => {
            const providerChannel = db.prepare('INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, ?, ?)')
                .run(provider, remoteId, `Channel ${remoteId}`).lastInsertRowid;
            return db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)')
                .run(catId, providerChannel, sortOrder).lastInsertRowid;
        };
        const first = addAssignment(category, 101, 10);
        const second = addAssignment(category, 102, 20);
        const other = addAssignment(otherCategory, 103, 30);
        const foreign = addAssignment(foreignCategory, 104, 40);
        const submitted = {
            other: [other],
            foreign: [foreign],
            mixed: [second, other],
            unknown: [second, 999999],
            malformed: [second, 'not-an-id'],
            duplicate: [first, String(first)]
        }[kind];
        const before = db.prepare('SELECT id, sort_order FROM user_channels ORDER BY id').all();
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.reorderUserChannels({
            params: { catId: String(category) },
            body: { channel_ids: submitted },
            user: isAdmin ? { id: 1, is_admin: true } : { id: 2, is_admin: false }
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(db.prepare('SELECT id, sort_order FROM user_channels ORDER BY id').all()).toEqual(before);
    });

    it('maps only to a category with the same user and content type and allows explicit unmapping', () => {
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const target = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Live', 'live')").run().lastInsertRowid;
        const mapping = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, category_type)
          VALUES (?, 2, 10, 'Provider Live', 'live')
        `).run(provider).lastInsertRowid;
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.updateCategoryMapping({
            params: { id: String(mapping) }, body: { user_category_id: String(target) },
            user: { id: 2, is_admin: false }
        }, res);
        expect(db.prepare('SELECT user_category_id FROM category_mappings WHERE id = ?').get(mapping))
            .toEqual({ user_category_id: target });

        channelController.updateCategoryMapping({
            params: { id: String(mapping) }, body: { user_category_id: null },
            user: { id: 2, is_admin: false }
        }, res);
        expect(db.prepare('SELECT user_category_id FROM category_mappings WHERE id = ?').get(mapping))
            .toEqual({ user_category_id: null });
    });

    it.each([
        ["another user's category", 'foreign'],
        ['a category with the wrong type', 'wrong-type'],
        ['an unknown category', 'unknown'],
        ['a malformed category ID', 'malformed']
    ])('rejects mapping to %s without changing the mapping', (_label, kind) => {
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const foreign = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (3, 'Foreign', 'live')").run().lastInsertRowid;
        const wrongType = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Movies', 'movie')").run().lastInsertRowid;
        const mapping = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, category_type)
          VALUES (?, 2, 10, 'Provider Live', 'live')
        `).run(provider).lastInsertRowid;
        const target = { foreign, 'wrong-type': wrongType, unknown: 999999, malformed: 'not-an-id' }[kind];
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

        channelController.updateCategoryMapping({
            params: { id: String(mapping) }, body: { user_category_id: target },
            user: { id: 2, is_admin: false }
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(db.prepare('SELECT user_category_id FROM category_mappings WHERE id = ?').get(mapping))
            .toEqual({ user_category_id: null });
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

    const addAssignment = (userId, isHidden = 0) => {
        const categoryId = db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)')
            .run(userId, `Category ${userId}-${Date.now()}-${Math.random()}`).lastInsertRowid;
        const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES (?, 'http://provider.test', 'u', 'p', ?)")
            .run(`Provider ${userId}-${Date.now()}-${Math.random()}`, userId).lastInsertRowid;
        const providerChannelId = db.prepare('INSERT INTO provider_channels (provider_id, remote_stream_id, name) VALUES (?, ?, ?)')
            .run(providerId, Number(`${userId}${Date.now()}`.slice(-8)), `Channel ${userId}`).lastInsertRowid;
        const assignmentId = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, is_hidden) VALUES (?, ?, ?)')
            .run(categoryId, providerChannelId, isHidden).lastInsertRowid;
        return { assignmentId, categoryId, userId };
    };

    const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });

    it('atomically hides valid own assignments and reports the changed count', () => {
        const first = addAssignment(2);
        const second = addAssignment(2);
        const res = response();

        channelController.bulkDeleteUserChannels({
            body: { ids: [first.assignmentId, String(second.assignmentId)] },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, res);

        expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 2 });
        expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id IN (?, ?) ORDER BY id').all(first.assignmentId, second.assignmentId))
            .toEqual([{ is_hidden: 1 }, { is_hidden: 1 }]);
    });

    it.each([
        ['an unknown ID', ({ own }) => [own.assignmentId, 999999]],
        ['a malformed ID', ({ own }) => [own.assignmentId, 'not-an-id']],
        ['duplicate IDs', ({ own }) => [own.assignmentId, String(own.assignmentId)]]
    ])('rejects %s without writing or clearing caches', (_label, idsFor) => {
        const own = addAssignment(2);
        const before = db.prepare('SELECT is_hidden FROM user_channels WHERE id = ?').get(own.assignmentId);
        const cacheKey = 'user_2_live';
        channelsJsonCache.set(cacheKey, ['cached']);
        const res = response();

        channelController.bulkDeleteUserChannels({
            body: { ids: idsFor({ own }) },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id = ?').get(own.assignmentId)).toEqual(before);
        expect(channelsJsonCache.has(cacheKey)).toBe(true);
    });

    it('rejects mixed own and foreign assignments without partial writes', () => {
        const own = addAssignment(2);
        const foreign = addAssignment(3);
        const res = response();

        channelController.bulkDeleteUserChannels({
            body: { ids: [own.assignmentId, foreign.assignmentId] },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id IN (?, ?) ORDER BY id').all(own.assignmentId, foreign.assignmentId))
            .toEqual([{ is_hidden: 0 }, { is_hidden: 0 }]);
    });

    it('allows administrators to hide valid assignments across users and clears each cache', () => {
        const first = addAssignment(2);
        const second = addAssignment(3);
        channelsJsonCache.set('user_2_live', ['cached']);
        channelsJsonCache.set('user_3_live', ['cached']);
        const res = response();

        channelController.bulkDeleteUserChannels({
            body: { ids: [first.assignmentId, second.assignmentId] },
            user: { id: 1, is_admin: true, username: 'admin' }, ip: '127.0.0.1'
        }, res);

        expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 2 });
        expect(channelsJsonCache.has('user_2_live')).toBe(false);
        expect(channelsJsonCache.has('user_3_live')).toBe(false);
    });

    it('rejects an administrator request containing an unknown assignment', () => {
        const own = addAssignment(2);
        const res = response();

        channelController.bulkDeleteUserChannels({
            body: { ids: [own.assignmentId, 999999] },
            user: { id: 1, is_admin: true, username: 'admin' }, ip: '127.0.0.1'
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id = ?').get(own.assignmentId)).toEqual({ is_hidden: 0 });
    });

    it('reports only assignments whose visibility changed', () => {
        const visible = addAssignment(2, 0);
        const alreadyHidden = addAssignment(2, 1);
        const res = response();

        channelController.bulkDeleteUserChannels({
            body: { ids: [visible.assignmentId, alreadyHidden.assignmentId] },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, res);

        expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 1 });
    });

    it('rejects unknown bulk category IDs without deleting a valid category', () => {
        const category = addAssignment(2).categoryId;
        const res = response();

        channelController.bulkDeleteUserCategories({
            body: { ids: [category, 999999] },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(db.prepare('SELECT id FROM user_categories WHERE id = ?').get(category)).toEqual({ id: category });
    });

    it('deletes categories, assignments, and mappings atomically after validation', () => {
        const own = addAssignment(2);
        const providerId = db.prepare(`
          SELECT pc.provider_id
          FROM provider_channels pc
          JOIN user_channels uc ON uc.provider_channel_id = pc.id
          WHERE uc.id = ?
        `).get(own.assignmentId).provider_id;
        const mappingId = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
          VALUES (?, 2, 10, 'Mapped', ?, 'live')
        `).run(providerId, own.categoryId).lastInsertRowid;
        channelsJsonCache.set('user_2_live', ['cached']);
        const res = response();

        channelController.bulkDeleteUserCategories({
            body: { ids: [own.categoryId] },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, res);

        expect(res.json).toHaveBeenCalledWith({ success: true, deleted: 1 });
        expect(db.prepare('SELECT id FROM user_categories WHERE id = ?').get(own.categoryId)).toBeUndefined();
        expect(db.prepare('SELECT id FROM user_channels WHERE id = ?').get(own.assignmentId)).toBeUndefined();
        expect(db.prepare('SELECT user_category_id FROM category_mappings WHERE id = ?').get(mappingId))
          .toEqual({ user_category_id: null });
        expect(channelsJsonCache.has('user_2_live')).toBe(false);
    });

    it('rejects a mixed-owner category request without deleting either category', () => {
        const own = addAssignment(2);
        const foreign = addAssignment(3);
        const res = response();

        channelController.bulkDeleteUserCategories({
            body: { ids: [own.categoryId, foreign.categoryId] },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(db.prepare('SELECT id FROM user_categories WHERE id IN (?, ?) ORDER BY id').all(own.categoryId, foreign.categoryId))
          .toEqual([{ id: own.categoryId }, { id: foreign.categoryId }]);
    });

    it('retargets mapping-owned assignments and rebinds series aliases', () => {
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Mapping Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const source = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Source', 'live')").run().lastInsertRowid;
        const target = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Target', 'live')").run().lastInsertRowid;
        const mapping = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
          VALUES (?, 2, 77, 'Provider', ?, 'live')
        `).run(provider, source).lastInsertRowid;
        const channel = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, stream_type) VALUES (?, 77, 'Series', 77, 'live')").run(provider).lastInsertRowid;
        const assignment = db.prepare(`
          INSERT INTO user_channels
            (user_category_id, provider_channel_id, sort_order, custom_name, is_hidden, assignment_origin, mapping_id)
          VALUES (?, ?, 4, 'Custom', 1, 'mapping', ?)
        `).run(source, channel, mapping).lastInsertRowid;
        const alias = db.prepare(`
          INSERT INTO series_episode_aliases
            (user_channel_id, source_key, series_remote_id, remote_episode_id)
          VALUES (?, 'mapping-source', 77, 1)
        `).run(assignment).lastInsertRowid;
        const res = response();

        channelController.updateCategoryMapping({
            params: { id: String(mapping) }, body: { user_category_id: String(target) },
            user: { id: 2, is_admin: false }
        }, res);

        expect(res.json).toHaveBeenCalledWith({
            success: true, assignments_removed: 0, assignments_moved: 1, duplicates_merged: 0
        });
        expect(db.prepare('SELECT user_category_id, mapping_id, is_hidden, custom_name FROM user_channels WHERE id = ?').get(assignment))
          .toEqual({ user_category_id: target, mapping_id: mapping, is_hidden: 1, custom_name: 'Custom' });
        expect(db.prepare('SELECT id, user_channel_id FROM series_episode_aliases WHERE id = ?').get(alias))
          .toEqual({ id: alias, user_channel_id: assignment });
    });

    it('demotes stale mapping-owned assignments before retargeting', () => {
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Stale Mapping Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const source = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Stale Source', 'live')").run().lastInsertRowid;
        const target = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Stale Target', 'live')").run().lastInsertRowid;
        const mapping = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
          VALUES (?, 2, 77, 'Provider', ?, 'live')
        `).run(provider, source).lastInsertRowid;
        const channel = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, stream_type) VALUES (?, 77, 'Stale Channel', 99, 'live')").run(provider).lastInsertRowid;
        const assignment = db.prepare(`
          INSERT INTO user_channels (user_category_id, provider_channel_id, assignment_origin, mapping_id)
          VALUES (?, ?, 'mapping', ?)
        `).run(source, channel, mapping).lastInsertRowid;
        const res = response();

        channelController.updateCategoryMapping({
            params: { id: String(mapping) }, body: { user_category_id: String(target) },
            user: { id: 2, is_admin: false }
        }, res);

        expect(res.json).toHaveBeenCalledWith({
            success: true, assignments_removed: 0, assignments_moved: 0, duplicates_merged: 0
        });
        expect(db.prepare('SELECT user_category_id, assignment_origin, mapping_id FROM user_channels WHERE id = ?').get(assignment))
          .toEqual({ user_category_id: source, assignment_origin: 'legacy', mapping_id: null });
    });

    it('merges a retargeted assignment into a manual target and preserves aliases', () => {
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Merge Provider', 'http://provider.test', 'u', 'p', 2)").run().lastInsertRowid;
        const source = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Mapped Source', 'live')").run().lastInsertRowid;
        const target = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Manual Target', 'live')").run().lastInsertRowid;
        const mapping = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
          VALUES (?, 2, 88, 'Provider', ?, 'live')
        `).run(provider, source).lastInsertRowid;
        const channel = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, 88, 'Channel', 'live')").run(provider).lastInsertRowid;
        const manual = db.prepare(`
          INSERT INTO user_channels
            (user_category_id, provider_channel_id, sort_order, custom_name, is_hidden)
          VALUES (?, ?, 2, 'Manual name', 1)
        `).run(target, channel).lastInsertRowid;
        const mapped = db.prepare(`
          INSERT INTO user_channels
            (user_category_id, provider_channel_id, sort_order, custom_name, assignment_origin, mapping_id)
          VALUES (?, ?, 9, 'Mapped name', 'mapping', ?)
        `).run(source, channel, mapping).lastInsertRowid;
        const alias = db.prepare(`
          INSERT INTO series_episode_aliases
            (user_channel_id, source_key, series_remote_id, remote_episode_id)
          VALUES (?, 'merge-source', 88, 1)
        `).run(mapped).lastInsertRowid;
        const res = response();

        channelController.updateCategoryMapping({
            params: { id: String(mapping) }, body: { user_category_id: String(target) },
            user: { id: 2, is_admin: false }
        }, res);

        expect(res.json).toHaveBeenCalledWith({
            success: true, assignments_removed: 0, assignments_moved: 0, duplicates_merged: 1
        });
        expect(db.prepare('SELECT id, mapping_id, is_hidden, custom_name FROM user_channels WHERE user_category_id = ? AND provider_channel_id = ?').get(target, channel))
          .toEqual({ id: manual, mapping_id: null, is_hidden: 1, custom_name: 'Manual name' });
        expect(db.prepare('SELECT id, user_channel_id FROM series_episode_aliases WHERE id = ?').get(alias))
          .toEqual({ id: alias, user_channel_id: manual });
        expect(db.prepare('SELECT id FROM user_channels WHERE id = ?').get(mapped)).toBeUndefined();
    });

    it('removes mapping-owned cross-owner assignments on unmapping but keeps manual rows', () => {
        const provider = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('Cross Owner', 'http://provider.test', 'u', 'p', 3)").run().lastInsertRowid;
        const category = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Shared', 'live')").run().lastInsertRowid;
        const manualCategory = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, 'Manual', 'live')").run().lastInsertRowid;
        const mapping = db.prepare(`
          INSERT INTO category_mappings
            (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
          VALUES (?, 2, 99, 'Provider', ?, 'live')
        `).run(provider, category).lastInsertRowid;
        const channel = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, 99, 'Channel', 'live')").run(provider).lastInsertRowid;
        const owned = db.prepare(`
          INSERT INTO user_channels
            (user_category_id, provider_channel_id, assignment_origin, mapping_id, granted_by_admin, authorization_revoked)
          VALUES (?, ?, 'mapping', ?, 1, 0)
        `).run(category, channel, mapping).lastInsertRowid;
        const manual = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (?, ?)').run(manualCategory, channel).lastInsertRowid;
        const res = response();

        channelController.updateCategoryMapping({
            params: { id: String(mapping) }, body: { user_category_id: null },
            user: { id: 2, is_admin: false }
        }, res);

        expect(res.json).toHaveBeenCalledWith({
            success: true, assignments_removed: 1, assignments_moved: 0, duplicates_merged: 0
        });
        expect(db.prepare('SELECT id FROM user_channels WHERE id = ?').get(owned)).toBeUndefined();
        expect(db.prepare('SELECT id, mapping_id FROM user_channels WHERE id = ?').get(manual))
          .toEqual({ id: manual, mapping_id: null });
        expect(db.prepare('SELECT user_category_id FROM category_mappings WHERE id = ?').get(mapping))
          .toEqual({ user_category_id: null });
    });

    it('accepts exactly 5000 bulk category IDs and rejects larger requests before writing', () => {
        const insert = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (2, ?, 'live')");
        const ids = [];
        const create = db.transaction(() => {
            for (let i = 0; i < 5000; i++) ids.push(Number(insert.run(`bulk-${i}`).lastInsertRowid));
        });
        create();
        const accepted = response();
        channelController.bulkDeleteUserCategories({
            body: { ids }, user: { id: 1, is_admin: true, username: 'admin' }, ip: '127.0.0.1'
        }, accepted);
        expect(accepted.json).toHaveBeenCalledWith({ success: true, deleted: 5000 });

        const own = addAssignment(2);
        channelsJsonCache.set('user_2_live', ['cached']);
        const rejected = response();
        channelController.bulkDeleteUserChannels({
            body: { ids: [own.assignmentId, ...Array.from({ length: 5000 }, (_, i) => i + 100000)] },
            user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1'
        }, rejected);
        expect(rejected.status).toHaveBeenCalledWith(400);
        expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id = ?').get(own.assignmentId)).toEqual({ is_hidden: 0 });
        expect(channelsJsonCache.has('user_2_live')).toBe(true);
    });
});
