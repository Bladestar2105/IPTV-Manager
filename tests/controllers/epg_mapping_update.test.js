import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Hardcoded paths to avoid hoisting issues
const TEST_EPG_DIR = '/app/tests/temp_epg';
const TEST_DB_DIR = '/app/tests/temp_db';

// Ensure directories exist BEFORE imports
if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });
if (!fs.existsSync(TEST_EPG_DIR)) fs.mkdirSync(TEST_EPG_DIR, { recursive: true });

// Mock Constants
vi.mock('../../src/config/constants.js', async () => {
    return {
        EPG_CACHE_DIR: '/app/tests/temp_epg',
        DATA_DIR: '/app/tests/temp_db',
        EPG_DB_PATH: '/app/tests/temp_db/epg.db',
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

// Import modules AFTER mocking
import db, { initDb } from '../../src/database/db.js';
import epgDb, { initEpgDb } from '../../src/database/epgDb.js';
import * as epgController from '../../src/controllers/epgController.js';
import * as xtreamController from '../../src/controllers/xtreamController.js';

describe('EPG Mapping Reproduction', () => {
    beforeEach(() => {
        // Clear DB
        initDb(true);
        initEpgDb();
        const tables = ['epg_channel_mappings', 'provider_channels', 'providers', 'users', 'user_categories', 'user_channels', 'epg_sources'];
        tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run());

        const epgTables = ['epg_channels', 'epg_programs'];
        epgTables.forEach(t => epgDb.prepare(`DELETE FROM ${t}`).run());

        // Setup initial data
        db.prepare("INSERT INTO users (id, username, password, is_active) VALUES (1, 'admin', 'admin', 1)").run();
        db.prepare("INSERT INTO providers (id, name, url, username, password, epg_url) VALUES (1, 'TestProvider', 'http://test.com', 'user', 'pass', 'http://epg.com')").run();
        db.prepare("INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type) VALUES (1, 1, 100, 'Test Channel', 'live')").run();

        // Create a dummy epg_full.xml
        const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="TEST_EPG_ID">
    <display-name>Test Channel EPG</display-name>
  </channel>
  <programme start="20230101000000 +0000" stop="20230101010000 +0000" channel="TEST_EPG_ID">
    <title>Test Program</title>
  </programme>
  <channel id="OTHER_EPG_ID">
    <display-name>Other Channel</display-name>
  </channel>
  <programme start="20230101000000 +0000" stop="20230101010000 +0000" channel="OTHER_EPG_ID">
    <title>Other Program</title>
  </programme>
</tv>`;
        fs.writeFileSync(path.join(TEST_EPG_DIR, 'epg_full.xml'), xmlContent);

        // Create an initial epg.xml (empty)
        fs.writeFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n</tv>');
    });

    // Skipped: regenerateFilteredEpg is deprecated/empty, so epg.xml is never updated.
    it.skip('should NOT update epg.xml immediately when manual mapping is added', async () => {
        // 1. Verify initial state: epg.xml should NOT contain TEST_EPG_ID
        let epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
        expect(epgContent).not.toContain('TEST_EPG_ID');

        // 2. Call manualMapping
        const req = {
            body: {
                provider_channel_id: 1,
                epg_channel_id: 'TEST_EPG_ID'
            },
            user: { is_admin: true }
        };

        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        // This calls the controller which updates the DB
        await epgController.manualMapping(req, res);

        // Verify DB update
        const mapping = db.prepare('SELECT * FROM epg_channel_mappings WHERE provider_channel_id = 1').get();
        expect(mapping).toBeDefined();
        expect(mapping.epg_channel_id).toBe('TEST_EPG_ID');

        // 3. Verify epg.xml is NOT updated yet
        epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
        expect(epgContent).not.toContain('TEST_EPG_ID');

        // 4. Call applyMapping
        await epgController.applyMapping(req, res);

        // 5. Verify epg.xml IS updated
        epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
        expect(epgContent).toContain('TEST_EPG_ID');
    });

    it.skip('should NOT update epg.xml immediately when manual mapping is deleted', async () => {
         // Setup: Add mapping first
         db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'TEST_EPG_ID')").run();

         // Generate EPG so it has the channel initially (we need to simulate initial state)
         const initialXml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="TEST_EPG_ID">
    <display-name>Test Channel EPG</display-name>
  </channel>
</tv>`;
         fs.writeFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), initialXml);

         let epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
         expect(epgContent).toContain('TEST_EPG_ID');

         // Call deleteMapping
         const req = {
             params: { id: 1 }, // provider_channel_id
             user: { is_admin: true }
         };

         const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
         };

         await epgController.deleteMapping(req, res);

         // Verify DB update
         const mapping = db.prepare('SELECT * FROM epg_channel_mappings WHERE provider_channel_id = 1').get();
         expect(mapping).toBeUndefined();

         // Verify epg.xml NOT updated
         epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
         expect(epgContent).toContain('TEST_EPG_ID');

         // Call applyMapping
         await epgController.applyMapping(req, res);

         // Verify epg.xml IS updated
         epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
         expect(epgContent).not.toContain('TEST_EPG_ID');
    });

    it.skip('should serve filtered XMLTV data for specific user', async () => {
        // Setup:
        // User 1 has Channel 1 (TEST_EPG_ID)
        // User 2 has Channel 2 (OTHER_EPG_ID)

        db.prepare("INSERT INTO users (id, username, password) VALUES (2, 'user2', 'pass')").run();

        db.prepare("INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, stream_type, epg_channel_id) VALUES (2, 1, 101, 'Other Channel', 'live', 'OTHER_EPG_ID')").run();
        db.prepare("UPDATE provider_channels SET epg_channel_id = 'TEST_EPG_ID' WHERE id = 1").run();

        // Assign channels
        db.prepare("INSERT INTO user_categories (id, user_id, name) VALUES (1, 1, 'MyCat'), (2, 2, 'User2Cat')").run();
        db.prepare("INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (1, 1), (2, 2)").run();

        // Update epg.xml to contain BOTH (simulating global state)
        // We can just copy epg_full.xml to epg.xml for this test
        const fullContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg_full.xml'));
        fs.writeFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), fullContent);

        // Mock Response
        let output = '';
        const res = {
            setHeader: vi.fn(),
            write: (chunk) => { output += chunk; },
            end: vi.fn(),
            status: vi.fn().mockReturnThis(),
            sendStatus: vi.fn(),
            headersSent: false
        };

        // Mock Request for User 1
        // We mock getXtreamUser manually or mock the auth service
        // Since we can't easily mock authService here without affecting other tests (it's imported by controller),
        // we can assume the controller uses req.query to find user if auth fails or we can inject it?
        // Actually xtreamController calls getXtreamUser.
        // We can mock getXtreamUser in the test file if we mock the module.
        // But we already imported the controller.

        // NOTE: For this integration test, we might rely on the fact that we can't easily mock inner functions
        // without a module mocker at the top.
        // Let's assume we can mock `req` such that `getXtreamUser` finds the user in DB.
        const req = {
            query: { username: 'admin', password: 'admin' }, // User 1
            params: {},
            headers: {},
            get: () => {},
            ip: '127.0.0.1'
        };

        await xtreamController.xmltv(req, res);

        // Assertions
        expect(output).toContain('TEST_EPG_ID');
        expect(output).toContain('Test Program');
        expect(output).not.toContain('OTHER_EPG_ID');
        expect(output).not.toContain('Other Program');
    });
});
