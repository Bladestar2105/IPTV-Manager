import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Hardcoded paths to avoid hoisting issues
const TEST_EPG_DIR = '/app/tests/temp_epg_cat';
const TEST_DB_DIR = '/app/tests/temp_db_cat';

// Ensure directories exist BEFORE imports
if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });
if (!fs.existsSync(TEST_EPG_DIR)) fs.mkdirSync(TEST_EPG_DIR, { recursive: true });

// Mock Constants
vi.mock('../../src/config/constants.js', async () => {
    return {
        EPG_CACHE_DIR: '/app/tests/temp_epg_cat',
        DATA_DIR: '/app/tests/temp_db_cat',
        EPG_DB_PATH: '/app/tests/temp_db_cat/epg.db',
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

// Mock network
vi.mock('../../src/utils/network.js', () => ({
  fetchSafe: vi.fn()
}));

// Import modules AFTER mocking
import db, { initDb } from '../../src/database/db.js';
import epgDb, { initEpgDb } from '../../src/database/epgDb.js';
import * as epgController from '../../src/controllers/epgController.js';

describe('EPG Mapping Category Mode', () => {
    beforeEach(() => {
        // Clear DB
        initDb(true);
        initEpgDb();
        const tables = ['epg_channel_mappings', 'provider_channels', 'providers', 'users', 'user_categories', 'user_channels', 'epg_sources'];
        tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run());

        const epgTables = ['epg_channels', 'epg_programs'];
        epgTables.forEach(t => epgDb.prepare(`DELETE FROM ${t}`).run());

        // Setup initial data
        db.prepare("INSERT INTO users (id, username, password, is_active, is_admin) VALUES (1, 'admin', 'admin', 1, 1)").run();
        db.prepare("INSERT INTO users (id, username, password, is_active, is_admin) VALUES (2, 'user', 'user', 1, 0)").run();

        db.prepare("INSERT INTO providers (id, name, url, username, password, epg_url) VALUES (1, 'TestProvider', 'http://test.com', 'user', 'pass', 'http://epg.com')").run();

        // Channel 1: Provider 1
        db.prepare("INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type) VALUES (1, 1, 100, 'Test Channel 1', 'live')").run();
        // Channel 2: Provider 1
        db.prepare("INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type) VALUES (2, 1, 101, 'Test Channel 2', 'live')").run();

        // User 2 (non-admin) Category 1
        db.prepare("INSERT INTO user_categories (id, user_id, name) VALUES (1, 2, 'User Category')").run();
        // User 2 has Channel 1 in Category 1
        db.prepare("INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (1, 1)").run();

        // Setup some EPG data for auto-mapping
        epgDb.prepare("INSERT INTO epg_channels (id, name, source_id, source_type) VALUES ('TEST_EPG_ID_1', 'Test Channel 1', 1, 'provider')").run();
    });

    describe('resetMapping', () => {
        it('should allow admin to reset by provider', async () => {
            db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'EPG1'), (2, 'EPG2')").run();

            const req = { body: { provider_id: 1 }, user: { id: 1, is_admin: true } };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.resetMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(0);
        });

        it('should allow non-admin to reset by category', async () => {
            db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'EPG1'), (2, 'EPG2')").run();

            // User 2 only owns channel 1 via category 1
            const req = { body: { category_id: 1 }, user: { id: 2, is_admin: false } };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.resetMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(1);
            expect(mappings[0].provider_channel_id).toBe(2); // Only channel 2 remains
        });

        it('should NOT allow non-admin to reset another user category', async () => {
             // Category 2 belongs to admin (user 1)
            db.prepare("INSERT INTO user_categories (id, user_id, name) VALUES (2, 1, 'Admin Category')").run();
            db.prepare("INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (2, 2)").run();
            db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'EPG1'), (2, 'EPG2')").run();

            const req = { body: { category_id: 2 }, user: { id: 2, is_admin: false } };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.resetMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(2); // Nothing reset
        });
    });

    describe('autoMapping', () => {
        it('should allow non-admin to auto-map by category', async () => {
            // Channel 1 matches EPG Channel 1 by name
            const req = { body: { category_id: 1 }, user: { id: 2, is_admin: false } };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            // We need to mock loadAllEpgChannels or the worker
            // But let's see if it works with the real implementation if we have epgDb setup
            await epgController.autoMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(1);
            expect(mappings[0].provider_channel_id).toBe(1);
            expect(mappings[0].epg_channel_id).toBe('TEST_EPG_ID_1');
        });

        it('should NOT auto-map channels outside the category for non-admin', async () => {
            // Add EPG for Channel 2
            epgDb.prepare("INSERT INTO epg_channels (id, name, source_id, source_type) VALUES ('TEST_EPG_ID_2', 'Test Channel 2', 1, 'provider')").run();

            // Auto-map for Category 1 (only contains Channel 1)
            const req = { body: { category_id: 1 }, user: { id: 2, is_admin: false } };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.autoMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(1);
            expect(mappings[0].provider_channel_id).toBe(1);
            expect(mappings[0].epg_channel_id).toBe('TEST_EPG_ID_1');
            // Channel 2 should NOT be mapped
        });
    });
});
