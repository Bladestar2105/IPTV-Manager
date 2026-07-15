import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

describe('Export/Import Regression Tests', () => {
    const TEST_EXPORT_PASSWORD = 'exportpassword123';
    const TEST_PROVIDER_PASSWORD = 'providerpassword456';
    const TEST_PROVIDER_PLAINTEXT = 'plaintextpassword';
    const previousDataDir = process.env.DATA_DIR;
    let db;
    let systemController;
    let encrypt;
    let decrypt;
    let decryptWithPassword;
    let encryptWithPassword;
    let testDataDir;
    let tempFilePath;

    beforeAll(async () => {
        testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-export-regression-'));
        tempFilePath = path.join(testDataDir, 'export.bin');
        process.env.DATA_DIR = testDataDir;
        vi.resetModules();

        const dbModule = await import('../src/database/db.js');
        db = dbModule.default;
        systemController = await import('../src/controllers/systemController.js');
        const cryptoModule = await import('../src/utils/crypto.js');
        encrypt = cryptoModule.encrypt;
        decrypt = cryptoModule.decrypt;
        decryptWithPassword = cryptoModule.decryptWithPassword;
        encryptWithPassword = cryptoModule.encryptWithPassword;

        const { initDb } = dbModule;
        initDb(true);
        // Clean up previous runs
        db.prepare('PRAGMA foreign_keys = OFF').run();
        try { db.prepare('DELETE FROM user_channels').run(); } catch(e) {}
        try { db.prepare('DELETE FROM user_categories').run(); } catch(e) {}
        try { db.prepare('DELETE FROM provider_channels').run(); } catch(e) {}
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();
        db.prepare('PRAGMA foreign_keys = ON').run();

        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    });

    afterAll(() => {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        try { db?.close(); } catch(e) {}
        if (testDataDir) fs.rmSync(testDataDir, { recursive: true, force: true });
        if (previousDataDir === undefined) {
            delete process.env.DATA_DIR;
        } else {
            process.env.DATA_DIR = previousDataDir;
        }
    });

    it('should export and import correctly (standard workflow)', async () => {
        // 1. Create User
        const userRes = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('testuser_std', 'userpass');
        const userId = userRes.lastInsertRowid;

        // 2. Create Provider with Encrypted Password
        const encryptedPass = encrypt(TEST_PROVIDER_PASSWORD);
        db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id)
            VALUES (?, ?, ?, ?, ?)
        `).run('TestProvider', 'http://example.com', 'user', encryptedPass, userId);

        // 3. Export Data
        const reqExport = {
            user: { is_admin: true },
            body: { password: TEST_EXPORT_PASSWORD, user_id: 'all' },
            query: {}
        };

        let exportedBuffer = null;
        const resExport = {
            setHeader: vi.fn(),
            status: vi.fn().mockReturnThis(),
            json: vi.fn((data) => console.log("Export JSON error:", data)),
            send: vi.fn((buffer) => { exportedBuffer = buffer; })
        };

        systemController.exportData(reqExport, resExport);

        expect(exportedBuffer).not.toBeNull();
        fs.writeFileSync(tempFilePath, exportedBuffer);

        // 4. Import Data (Clear DB first)
        db.prepare('PRAGMA foreign_keys = OFF').run();
        try { db.prepare('DELETE FROM user_channels').run(); } catch(e) {}
        try { db.prepare('DELETE FROM user_categories').run(); } catch(e) {}
        try { db.prepare('DELETE FROM provider_channels').run(); } catch(e) {}
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();
        db.prepare('PRAGMA foreign_keys = ON').run();

        const reqImport = {
            user: { is_admin: true },
            body: { password: TEST_EXPORT_PASSWORD },
            file: { path: tempFilePath }
        };

        const resImport = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        await systemController.importData(reqImport, resImport);
        expect(resImport.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

        // 5. Verify Provider Password
        const importedUser = db.prepare('SELECT * FROM users WHERE username = ?').get('testuser_std');
        const importedProvider = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(importedUser.id);

        const decryptedImportedPass = decrypt(importedProvider.password);
        expect(decryptedImportedPass).toBe(TEST_PROVIDER_PASSWORD);
    });

    it('should fallback to plaintext export if decryption fails (plaintext password in DB)', () => {
        // Clear DB
        db.prepare('PRAGMA foreign_keys = OFF').run();
        try { db.prepare('DELETE FROM user_channels').run(); } catch(e) {}
        try { db.prepare('DELETE FROM user_categories').run(); } catch(e) {}
        try { db.prepare('DELETE FROM provider_channels').run(); } catch(e) {}
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();
        db.prepare('PRAGMA foreign_keys = ON').run();

        // 1. Create User
        const userRes = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('testuser_plain', 'userpass');
        const userId = userRes.lastInsertRowid;

        // 2. Create Provider with Plaintext Password
        db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id)
            VALUES (?, ?, ?, ?, ?)
        `).run('TestPlain', 'http://example.com', 'user', TEST_PROVIDER_PLAINTEXT, userId);

        // 3. Export Data
        const reqExport = {
            user: { is_admin: true },
            body: { password: TEST_EXPORT_PASSWORD, user_id: 'all' },
            query: {}
        };

        let exportedBuffer = null;
        const resExport = {
            setHeader: vi.fn(),
            status: vi.fn().mockReturnThis(),
            json: vi.fn((data) => console.log("Export JSON error:", data)),
            send: vi.fn((buffer) => { exportedBuffer = buffer; })
        };

        systemController.exportData(reqExport, resExport);

        expect(exportedBuffer).not.toBeNull();

        // 4. Verify Export Content manually
        const compressed = decryptWithPassword(exportedBuffer, TEST_EXPORT_PASSWORD);
        const jsonStr = zlib.gunzipSync(compressed).toString('utf8');
        const exportData = JSON.parse(jsonStr);

        const exportedProvider = exportData.providers.find(p => p.username === 'user');
        expect(exportedProvider).toBeDefined();

        // Should contain plaintext because decrypt(plaintext) returns null, so it falls back to original
        expect(exportedProvider.password).toBe(TEST_PROVIDER_PLAINTEXT);
    });

    it('normalizes imported grants against the rebuilt ownership relationships', async () => {
        db.prepare('PRAGMA foreign_keys = OFF').run();
        for (const table of ['user_channels', 'category_mappings', 'sync_configs', 'provider_channels', 'providers', 'user_categories', 'users']) {
            db.prepare(`DELETE FROM ${table}`).run();
        }
        db.prepare('PRAGMA foreign_keys = ON').run();

        const ownerId = db.prepare("INSERT INTO users (username, password) VALUES ('import_owner', 'pass')").run().lastInsertRowid;
        const targetId = db.prepare("INSERT INTO users (username, password) VALUES ('import_target', 'pass')").run().lastInsertRowid;
        const providerId = db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id)
            VALUES ('Shared Provider', 'http://shared.example', 'u', ?, ?)
        `).run(encrypt('provider-pass'), ownerId).lastInsertRowid;
        const sameOwnerProviderId = db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id)
            VALUES ('Owner Provider', 'http://owner.example', 'u', ?, ?)
        `).run(encrypt('provider-pass'), ownerId).lastInsertRowid;
        const channelA = db.prepare(`
            INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type)
            VALUES (?, 101, 'Series A', 'series')
        `).run(providerId).lastInsertRowid;
        const channelB = db.prepare(`
            INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type)
            VALUES (?, 102, 'Series B', 'series')
        `).run(providerId).lastInsertRowid;
        const sameCategory = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Same owner', 'series')").run(ownerId).lastInsertRowid;
        const grantedCategory = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Cross granted', 'series')").run(targetId).lastInsertRowid;
        const ungrantedCategory = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Cross ungranted', 'series')").run(targetId).lastInsertRowid;

        db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, granted_by_admin) VALUES (?, ?, 1)').run(sameCategory, channelA);
        db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, granted_by_admin) VALUES (?, ?, 1)').run(grantedCategory, channelA);
        db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, granted_by_admin) VALUES (?, ?, 0)').run(ungrantedCategory, channelB);
        db.prepare("INSERT INTO sync_configs (provider_id, user_id, enabled, granted_by_admin) VALUES (?, ?, 1, 1)").run(providerId, targetId);
        db.prepare("INSERT INTO sync_configs (provider_id, user_id, enabled, granted_by_admin) VALUES (?, ?, 1, 1)").run(sameOwnerProviderId, ownerId);

        let exportedBuffer;
        systemController.exportData(
            { user: { is_admin: true }, body: { password: TEST_EXPORT_PASSWORD, user_id: 'all' }, query: {} },
            { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn(buffer => { exportedBuffer = buffer; }) }
        );

        const exportedData = JSON.parse(zlib.gunzipSync(decryptWithPassword(exportedBuffer, TEST_EXPORT_PASSWORD)).toString('utf8'));
        exportedData.channels.push({
            id: 999999,
            type: 'user_assignment',
            user_category_id: grantedCategory,
            provider_channel_id: 999999,
            granted_by_admin: 1,
            is_hidden: 0,
        });
        exportedBuffer = encryptWithPassword(zlib.gzipSync(JSON.stringify(exportedData)), TEST_EXPORT_PASSWORD);
        fs.writeFileSync(tempFilePath, exportedBuffer);

        db.prepare('PRAGMA foreign_keys = OFF').run();
        for (const table of ['user_channels', 'category_mappings', 'sync_configs', 'provider_channels', 'providers', 'user_categories', 'users']) {
            db.prepare(`DELETE FROM ${table}`).run();
        }
        db.prepare('PRAGMA foreign_keys = ON').run();

        const resImport = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        await systemController.importData(
            { user: { is_admin: true }, body: { password: TEST_EXPORT_PASSWORD }, file: { path: tempFilePath } },
            resImport
        );

        expect(resImport.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        const assignments = db.prepare(`
            SELECT cat.name, uc.is_hidden, uc.granted_by_admin
            FROM user_channels uc
            JOIN user_categories cat ON cat.id = uc.user_category_id
            ORDER BY cat.name
        `).all();
        expect(assignments).toEqual([
            { name: 'Cross granted', is_hidden: 0, granted_by_admin: 1 },
            { name: 'Cross ungranted', is_hidden: 1, granted_by_admin: 0 },
            { name: 'Same owner', is_hidden: 0, granted_by_admin: 0 },
        ]);

        const configs = db.prepare(`
            SELECT p.name, sc.enabled, sc.granted_by_admin
            FROM sync_configs sc JOIN providers p ON p.id = sc.provider_id
            ORDER BY p.name
        `).all();
        expect(configs).toEqual([
            { name: 'Owner Provider', enabled: 1, granted_by_admin: 0 },
            { name: 'Shared Provider', enabled: 1, granted_by_admin: 1 },
        ]);
    });
});
