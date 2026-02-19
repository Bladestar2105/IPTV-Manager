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
        PORT: 3000,
        BCRYPT_ROUNDS: 1
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
import * as epgController from '../../src/controllers/epgController.js';

describe('EPG Mapping Reproduction', () => {
    beforeEach(() => {
        // Clear DB
        initDb(true);
        const tables = ['epg_channel_mappings', 'provider_channels', 'providers', 'users', 'epg_sources'];
        tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run());

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
</tv>`;
        fs.writeFileSync(path.join(TEST_EPG_DIR, 'epg_full.xml'), xmlContent);

        // Create an initial epg.xml (empty)
        fs.writeFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n</tv>');
    });

    it('should update epg.xml when a manual mapping is added', async () => {
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

        // 3. Verify epg.xml is updated
        epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
        expect(epgContent).toContain('TEST_EPG_ID');
    });

    it('should update epg.xml when a manual mapping is deleted', async () => {
         // Setup: Add mapping first
         db.prepare("INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (1, 'TEST_EPG_ID')").run();

         // Generate EPG so it has the channel initially (we need to simulate initial state)
         // Since we can't easily call generateConsolidatedEpg without setup, let's just write the file manually
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

         // Verify epg.xml update
         epgContent = fs.readFileSync(path.join(TEST_EPG_DIR, 'epg.xml'), 'utf8');
         expect(epgContent).not.toContain('TEST_EPG_ID');
    });
});
