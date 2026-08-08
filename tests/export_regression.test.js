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
        const userRes = db.prepare('INSERT INTO users (username, password, provider_access) VALUES (?, ?, 1)').run('testuser_std', 'userpass');
        const userId = userRes.lastInsertRowid;

        // 2. Create Provider with Encrypted Password
        const encryptedPass = encrypt(TEST_PROVIDER_PASSWORD);
        db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id, timeshift_timezone)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run('TestProvider', 'http://example.com', 'user', encryptedPass, userId, 'Europe/Berlin');

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
        const exportedFormat = JSON.parse(zlib.gunzipSync(decryptWithPassword(exportedBuffer, TEST_EXPORT_PASSWORD)).toString('utf8'));
        expect(exportedFormat.version).toBe(2);
        expect(exportedFormat.assignment_provenance_version).toBe(1);

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

        expect(importedUser.provider_access).toBe(1);
        const decryptedImportedPass = decrypt(importedProvider.password);
        expect(decryptedImportedPass).toBe(TEST_PROVIDER_PASSWORD);
        expect(importedProvider.timeshift_timezone).toBe('Europe/Berlin');
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

        const failClosedImport = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        await systemController.importData(
            { user: { is_admin: true }, body: { password: TEST_EXPORT_PASSWORD }, file: { path: tempFilePath } },
            failClosedImport
        );
        expect(failClosedImport.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(db.prepare(`
          SELECT uc.granted_by_admin, uc.authorization_revoked
          FROM user_channels uc
          JOIN user_categories cat ON cat.id = uc.user_category_id
          WHERE cat.name = 'Cross granted'
        `).get()).toEqual({ granted_by_admin: 0, authorization_revoked: 1 });
        expect(db.prepare(`
          SELECT sc.enabled, sc.granted_by_admin
          FROM sync_configs sc
          JOIN providers p ON p.id = sc.provider_id
          WHERE p.name = 'Shared Provider'
        `).get()).toEqual({ enabled: 0, granted_by_admin: 0 });

        db.prepare('PRAGMA foreign_keys = OFF').run();
        for (const table of ['user_channels', 'category_mappings', 'sync_configs', 'provider_channels', 'providers', 'user_categories', 'users']) {
            db.prepare(`DELETE FROM ${table}`).run();
        }
        db.prepare('PRAGMA foreign_keys = ON').run();
        fs.writeFileSync(tempFilePath, exportedBuffer);

        const resImport = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        await systemController.importData(
            {
              user: { is_admin: true },
              body: { password: TEST_EXPORT_PASSWORD, allow_cross_owner: 'true' },
              file: { path: tempFilePath }
            },
            resImport
        );

        expect(resImport.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        const assignments = db.prepare(`
            SELECT cat.name, uc.is_hidden, uc.granted_by_admin, uc.authorization_revoked
            FROM user_channels uc
            JOIN user_categories cat ON cat.id = uc.user_category_id
            ORDER BY cat.name
        `).all();
        expect(assignments).toEqual([
            { name: 'Cross granted', is_hidden: 0, granted_by_admin: 1, authorization_revoked: 0 },
            { name: 'Cross ungranted', is_hidden: 0, granted_by_admin: 0, authorization_revoked: 1 },
            { name: 'Same owner', is_hidden: 0, granted_by_admin: 0, authorization_revoked: 0 },
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

    it('preserves validated modern mapping provenance after ID remapping', async () => {
        db.prepare('PRAGMA foreign_keys = OFF').run();
        for (const table of ['user_channels', 'category_mappings', 'sync_configs', 'provider_channels', 'providers', 'user_categories', 'users']) {
            db.prepare(`DELETE FROM ${table}`).run();
        }
        db.prepare('PRAGMA foreign_keys = ON').run();

        const userId = db.prepare("INSERT INTO users (username, password) VALUES ('mapped_import', 'pass')").run().lastInsertRowid;
        const providerId = db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id)
            VALUES ('Mapped Provider', 'http://mapped.example', 'u', ?, ?)
        `).run(encrypt('provider-pass'), userId).lastInsertRowid;
        const channelId = db.prepare(`
            INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, stream_type)
            VALUES (?, 701, 'Mapped Series', 77, 'series')
        `).run(providerId).lastInsertRowid;
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Mapped', 'series')").run(userId).lastInsertRowid;
        const mappingId = db.prepare(`
            INSERT INTO category_mappings
              (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
            VALUES (?, ?, 77, 'Mapped', ?, 'series')
        `).run(providerId, userId, categoryId).lastInsertRowid;
        db.prepare(`
            INSERT INTO user_channels (user_category_id, provider_channel_id, assignment_origin, mapping_id)
            VALUES (?, ?, 'mapping', ?)
        `).run(categoryId, channelId, mappingId);

        let exportedBuffer;
        systemController.exportData(
            { user: { is_admin: true }, body: { password: TEST_EXPORT_PASSWORD, user_id: 'all' }, query: {} },
            { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn(buffer => { exportedBuffer = buffer; }) }
        );
        const exportedData = JSON.parse(zlib.gunzipSync(decryptWithPassword(exportedBuffer, TEST_EXPORT_PASSWORD)).toString('utf8'));
        const sourceMappingId = exportedData.mappings.find(mapping => mapping.id === Number(mappingId)).id;
        fs.writeFileSync(tempFilePath, encryptWithPassword(zlib.gzipSync(JSON.stringify(exportedData)), TEST_EXPORT_PASSWORD));

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

        const restored = db.prepare('SELECT assignment_origin, mapping_id FROM user_channels').get();
        expect(restored.assignment_origin).toBe('mapping');
        expect(Number(restored.mapping_id)).not.toBe(Number(sourceMappingId));
        expect(db.prepare('SELECT provider_category_id FROM category_mappings WHERE id = ?').get(restored.mapping_id))
            .toEqual({ provider_category_id: 77 });
    });

    it('merges duplicate assignments during system import and reports unique counts', async () => {
        db.prepare('PRAGMA foreign_keys = OFF').run();
        for (const table of ['user_channels', 'category_mappings', 'sync_configs', 'provider_channels', 'providers', 'user_categories', 'users']) {
            db.prepare(`DELETE FROM ${table}`).run();
        }
        db.prepare('PRAGMA foreign_keys = ON').run();

        const userId = db.prepare("INSERT INTO users (username, password) VALUES ('duplicate_import', 'pass')").run().lastInsertRowid;
        const providerId = db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id)
            VALUES ('Duplicate Provider', 'http://duplicate.example', 'u', ?, ?)
        `).run(encrypt('provider-pass'), userId).lastInsertRowid;
        const channelId = db.prepare(`
            INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type)
            VALUES (?, 501, 'Duplicate Channel', 'series')
        `).run(providerId).lastInsertRowid;
        const categoryId = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Duplicate', 'series')").run(userId).lastInsertRowid;
        db.prepare(`
            INSERT INTO user_channels
              (user_category_id, provider_channel_id, sort_order, assignment_origin, custom_name, is_hidden)
            VALUES (?, ?, 4, 'legacy', '', 0)
        `).run(categoryId, channelId);

        let exportedBuffer;
        systemController.exportData(
            { user: { is_admin: true }, body: { password: TEST_EXPORT_PASSWORD, user_id: 'all' }, query: {} },
            { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn(buffer => { exportedBuffer = buffer; }) }
        );
        const exportedData = JSON.parse(zlib.gunzipSync(decryptWithPassword(exportedBuffer, TEST_EXPORT_PASSWORD)).toString('utf8'));
        const sourceAssignment = exportedData.channels.find(channel => channel.type === 'user_assignment');
        exportedData.channels.push({
            ...sourceAssignment,
            id: 9999,
            assignment_origin: 'mapping',
            mapping_id: 123456,
            sort_order: 0,
            custom_name: 'Imported name',
            is_hidden: 1,
        });
        fs.writeFileSync(tempFilePath, encryptWithPassword(zlib.gzipSync(JSON.stringify(exportedData)), TEST_EXPORT_PASSWORD));

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

        expect(resImport.json).toHaveBeenCalledWith({
            success: true,
            stats: expect.objectContaining({ channels: 1, channels_merged: 1, channels_skipped: 0 })
        });
        expect(db.prepare(`
            SELECT assignment_origin, mapping_id, sort_order, custom_name, is_hidden
            FROM user_channels
        `).get()).toEqual({
            assignment_origin: 'legacy', mapping_id: null, sort_order: 0,
            custom_name: 'Imported name', is_hidden: 1
        });
    });
});
