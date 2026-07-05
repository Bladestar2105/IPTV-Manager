import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Temp paths must be writable outside Docker too.
const TEST_EPG_DIR = '/tmp/iptv-manager-temp_epg_cat';
const TEST_DB_DIR = '/tmp/iptv-manager-temp_db_cat';

// Ensure directories exist BEFORE imports
if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });
if (!fs.existsSync(TEST_EPG_DIR)) fs.mkdirSync(TEST_EPG_DIR, { recursive: true });
process.env.DATA_DIR = TEST_DB_DIR;

// Mock Constants
vi.mock('../../src/config/constants.js', async () => {
    return {
        EPG_CACHE_DIR: '/tmp/iptv-manager-temp_epg_cat',
        DATA_DIR: '/tmp/iptv-manager-temp_db_cat',
        EPG_DB_PATH: '/tmp/iptv-manager-temp_db_cat/epg.db',
        PORT: 3000,
        BCRYPT_ROUNDS: 1,
        JWT_EXPIRES_IN: '1h',
        AUTH_CACHE_TTL: 60000,
        AUTH_CACHE_MAX_SIZE: 100,
        AUTH_CACHE_CLEANUP_INTERVAL: 60000
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
        const tables = ['epg_mapping_jobs', 'epg_channel_mappings', 'provider_channels', 'providers', 'users', 'user_categories', 'user_channels', 'epg_sources'];
        tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run());

        const epgTables = ['epg_channels', 'epg_programs'];
        epgTables.forEach(t => epgDb.prepare(`DELETE FROM ${t}`).run());

        // Setup initial data
        db.prepare("INSERT INTO users (id, username, password, is_active) VALUES (1, 'admin', 'admin', 1)").run();
        db.prepare("INSERT INTO users (id, username, password, is_active) VALUES (2, 'user', 'user', 1)").run();

        db.prepare("INSERT INTO providers (id, name, url, username, password, epg_url) VALUES (1, 'TestProvider', 'http://test.com', 'user', 'pass', 'http://epg.com')").run();
        db.prepare("INSERT INTO providers (id, name, url, username, password, epg_url) VALUES (2, 'SecondProvider', 'http://test2.com', 'user', 'pass', 'http://epg2.com')").run();

        // Channel 1: Provider 1
        db.prepare("INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type) VALUES (1, 1, 100, 'Test Channel 1', 'live')").run();
        // Channel 2: Provider 1
        db.prepare("INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type) VALUES (2, 1, 101, 'Test Channel 2', 'live')").run();
        // Channel 3: Provider 2
        db.prepare("INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type) VALUES (3, 2, 102, 'Second Provider Channel', 'live')").run();

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

            const req = { body: { provider_id: 1 }, user: { id: 1, is_admin: true, username: 'admin' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.resetMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(0);
        });

        it('should allow admin to reset mappings across all providers', async () => {
            db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'EPG1'), (2, 'EPG2'), (3, 'EPG3')").run();

            const req = { body: { all_providers: true }, user: { id: 1, is_admin: true, username: 'admin' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.resetMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(0);
            expect(res.json).toHaveBeenCalledWith({success: true, reset: 3});
        });

        it('should reject non-admin reset across all providers', async () => {
            db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'EPG1')").run();

            const req = { body: { all_providers: true }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.resetMapping(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(db.prepare("SELECT COUNT(*) as count FROM epg_channel_mappings").get().count).toBe(1);
        });

        it('should allow non-admin to reset by category', async () => {
            db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'EPG1'), (2, 'EPG2')").run();

            // User 2 only owns channel 1 via category 1
            const req = { body: { category_id: 1 }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
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

            const req = { body: { category_id: 2 }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.resetMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(2); // Nothing reset
        });
    });

    describe('autoMapping', () => {
        it('should allow non-admin to auto-map by category', async () => {
            // Channel 1 matches EPG Channel 1 by name
            const req = { body: { category_id: 1 }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            // We need to mock loadAllEpgChannels or the worker
            // But let's see if it works with the real implementation if we have epgDb setup
            await epgController.autoMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings").all();
            expect(mappings.length).toBe(1);
            expect(mappings[0].provider_channel_id).toBe(1);
            expect(mappings[0].epg_channel_id).toBe('TEST_EPG_ID_1');
        });

        it('should allow admin to auto-map unmapped channels across all providers', async () => {
            epgDb.prepare("INSERT INTO epg_channels (id, name, source_id, source_type) VALUES ('TEST_EPG_ID_3', 'Second Provider Channel', 1, 'provider')").run();

            const req = { body: { all_providers: true }, user: { id: 1, is_admin: true, username: 'admin' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.autoMapping(req, res);

            const mappings = db.prepare("SELECT * FROM epg_channel_mappings ORDER BY provider_channel_id").all();
            expect(mappings.map(m => m.provider_channel_id)).toEqual([1, 3]);
            expect(mappings.map(m => m.epg_channel_id)).toEqual(['TEST_EPG_ID_1', 'TEST_EPG_ID_3']);
        });

        it('should reject non-admin auto-map across all providers', async () => {
            const req = { body: { all_providers: true }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.autoMapping(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(db.prepare("SELECT COUNT(*) as count FROM epg_channel_mappings").get().count).toBe(0);
        });

        it('should run auto-map in background and expose progress', async () => {
            const req = { body: { category_id: 1, background: true }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.autoMapping(req, res);

            const startResponse = res.json.mock.calls[0][0];
            expect(startResponse.success).toBe(true);
            expect(startResponse.job_id).toBeTruthy();

            let job;
            for (let i = 0; i < 40; i++) {
                const statusRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
                await epgController.getMappingJob({ params: { id: startResponse.job_id }, user: req.user }, statusRes);
                job = statusRes.json.mock.calls[0][0];
                if (job.status === 'completed') break;
                await new Promise(resolve => setTimeout(resolve, 25));
            }

            expect(job.status).toBe('completed');
            expect(job.progress).toBe(100);
            expect(job.matched).toBe(1);
            expect(db.prepare("SELECT COUNT(*) as count FROM epg_channel_mappings").get().count).toBe(1);
        });

        it('should persist background jobs for cluster-safe polling', async () => {
            const req = { body: { category_id: 1, background: true }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
            const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

            await epgController.autoMapping(req, res);

            const startResponse = res.json.mock.calls[0][0];
            const row = db.prepare("SELECT id, status, progress, user_id FROM epg_mapping_jobs WHERE id = ?").get(startResponse.job_id);

            expect(row).toMatchObject({
                id: startResponse.job_id,
                status: 'running',
                user_id: 2
            });
            expect(row.progress).toBeLessThan(10);

            const now = Date.now();
            db.prepare(`
                INSERT INTO epg_mapping_jobs (id, status, progress, matched, user_id, created_at, updated_at)
                VALUES ('cluster-safe-job', 'running', 42, 0, 2, ?, ?)
            `).run(now, now);
            const statusRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
            await epgController.getMappingJob({ params: { id: 'cluster-safe-job' }, user: req.user }, statusRes);

            expect(statusRes.json.mock.calls[0][0].progress).toBe(42);
        });

        it('should NOT auto-map channels outside the category for non-admin', async () => {
            // Add EPG for Channel 2
            epgDb.prepare("INSERT INTO epg_channels (id, name, source_id, source_type) VALUES ('TEST_EPG_ID_2', 'Test Channel 2', 1, 'provider')").run();

            // Auto-map for Category 1 (only contains Channel 1)
            const req = { body: { category_id: 1 }, user: { id: 2, is_admin: false, username: 'user' }, ip: '127.0.0.1' };
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
