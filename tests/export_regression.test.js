import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import db, { initDb } from '../src/database/db.js';
import * as systemController from '../src/controllers/systemController.js';
import { encrypt, decrypt, decryptWithPassword } from '../src/utils/crypto.js';

describe('Export/Import Regression Tests', () => {
    const TEST_EXPORT_PASSWORD = 'exportpassword123';
    const TEST_PROVIDER_PASSWORD = 'providerpassword456';
    const TEST_PROVIDER_PLAINTEXT = 'plaintextpassword';
    let tempFilePath = path.join(process.cwd(), 'temp_export_regression.bin');

    beforeAll(() => {
        initDb(true);
        // Clean up previous runs
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();

        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    });

    afterAll(() => {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    });

    it('should export and import correctly (standard workflow)', () => {
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
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();

        const reqImport = {
            user: { is_admin: true },
            body: { password: TEST_EXPORT_PASSWORD },
            file: { path: tempFilePath }
        };

        const resImport = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };

        systemController.importData(reqImport, resImport);
        expect(resImport.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

        // 5. Verify Provider Password
        const importedUser = db.prepare('SELECT * FROM users WHERE username = ?').get('testuser_std');
        const importedProvider = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(importedUser.id);

        const decryptedImportedPass = decrypt(importedProvider.password);
        expect(decryptedImportedPass).toBe(TEST_PROVIDER_PASSWORD);
    });

    it('should fallback to plaintext export if decryption fails (plaintext password in DB)', () => {
        // Clear DB
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();

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
});
