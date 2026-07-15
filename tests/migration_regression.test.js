import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import db, { initDb } from '../src/database/db.js';
import { encrypt, decrypt } from '../src/utils/crypto.js';
import { migrateProviderPasswords, migrateOtpSecrets, migrateUserChannelAdminGrants } from '../src/database/migrations.js';

describe('Migration Bug Regression', () => {
    beforeAll(() => {
        initDb(true);
        db.prepare('PRAGMA foreign_keys = OFF').run();
        try { db.prepare('DELETE FROM user_channels').run(); } catch(e) {}
        try { db.prepare('DELETE FROM user_categories').run(); } catch(e) {}
        try { db.prepare('DELETE FROM provider_channels').run(); } catch(e) {}
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();
        db.prepare('PRAGMA foreign_keys = ON').run();
    });

    it('should NOT re-encrypt GCM passwords', () => {
        const password = 'mysecretpassword';
        const encrypted = encrypt(password); // GCM format

        // Insert GCM encrypted password
        const info = db.prepare('INSERT INTO providers (name, url, username, password) VALUES (?, ?, ?, ?)').run('Test', 'http://x', 'u', encrypted);
        const id = info.lastInsertRowid;

        // Run migration
        migrateProviderPasswords(db);

        // Fetch back
        const row = db.prepare('SELECT password FROM providers WHERE id = ?').get(id);
        const decryptedOnce = decrypt(row.password);
        expect(decryptedOnce).toBe(password);
    });

    it('should NOT re-encrypt GCM OTP secrets', () => {
        const secret = 'myotpsecret';
        const encrypted = encrypt(secret);

        // Insert GCM encrypted OTP secret
        const info = db.prepare('INSERT INTO users (username, password, otp_secret) VALUES (?, ?, ?)').run('otpuser', 'pass', encrypted);
        const id = info.lastInsertRowid;

        // Run migration
        migrateOtpSecrets(db);

        // Fetch back
        const row = db.prepare('SELECT otp_secret FROM users WHERE id = ?').get(id);
        const decryptedOnce = decrypt(row.otp_secret);
        expect(decryptedOnce).toBe(secret);
    });

    it('should revoke legacy ownership mismatches idempotently without changing IDs', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec(`
              CREATE TABLE providers (id INTEGER PRIMARY KEY, user_id INTEGER);
              CREATE TABLE provider_channels (id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL);
              CREATE TABLE user_categories (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL);
              CREATE TABLE user_channels (
                id INTEGER PRIMARY KEY,
                user_category_id INTEGER NOT NULL,
                provider_channel_id INTEGER NOT NULL,
                sort_order INTEGER DEFAULT 0,
                custom_name TEXT DEFAULT '',
                is_hidden INTEGER DEFAULT 0
              );
              INSERT INTO providers (id, user_id) VALUES (10, 1);
              INSERT INTO provider_channels (id, provider_id) VALUES (20, 10);
              INSERT INTO user_categories (id, user_id) VALUES (30, 1), (31, 2);
              INSERT INTO user_channels (id, user_category_id, provider_channel_id)
                VALUES (40, 30, 20), (41, 31, 20);
            `);

            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(1);
            expect(legacyDb.prepare('SELECT id, is_hidden, granted_by_admin FROM user_channels ORDER BY id').all()).toEqual([
                { id: 40, is_hidden: 0, granted_by_admin: 0 },
                { id: 41, is_hidden: 1, granted_by_admin: 0 }
            ]);
            expect(legacyDb.prepare('SELECT id FROM authorized_user_channels ORDER BY id').all()).toEqual([{ id: 40 }]);

            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(0);
            expect(legacyDb.prepare('SELECT id FROM user_channels ORDER BY id').all()).toEqual([{ id: 40 }, { id: 41 }]);

            legacyDb.prepare('UPDATE user_channels SET is_hidden = 0, granted_by_admin = 1 WHERE id = 41').run();
            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(0);
            expect(legacyDb.prepare('SELECT id FROM authorized_user_channels ORDER BY id').all()).toEqual([{ id: 40 }, { id: 41 }]);
        } finally {
            legacyDb.close();
        }
    });
});
