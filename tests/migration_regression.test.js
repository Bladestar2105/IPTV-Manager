import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import db, { initDb } from '../src/database/db.js';
import { encrypt, decrypt } from '../src/utils/crypto.js';
import {
    migrateProviderPasswords,
    migrateOtpSecrets,
    migrateSeriesEpisodes,
    migrateUserChannelAdminGrants,
    migrateSyncConfigAdminGrants
} from '../src/database/migrations.js';

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
              CREATE VIEW authorized_user_channels AS SELECT * FROM user_channels;
            `);

            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(1);
            expect(legacyDb.prepare('SELECT id, is_hidden, granted_by_admin, authorization_revoked FROM user_channels ORDER BY id').all()).toEqual([
                { id: 40, is_hidden: 0, granted_by_admin: 0, authorization_revoked: 0 },
                { id: 41, is_hidden: 0, granted_by_admin: 0, authorization_revoked: 1 }
            ]);
            expect(legacyDb.prepare('SELECT id FROM authorized_user_channels ORDER BY id').all()).toEqual([{ id: 40 }]);

            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(0);
            expect(legacyDb.prepare('SELECT id FROM user_channels ORDER BY id').all()).toEqual([{ id: 40 }, { id: 41 }]);

            legacyDb.prepare('UPDATE user_channels SET granted_by_admin = 1, authorization_revoked = 0 WHERE id = 41').run();
            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(0);
            expect(legacyDb.prepare('SELECT id FROM authorized_user_channels ORDER BY id').all()).toEqual([{ id: 40 }, { id: 41 }]);
        } finally {
            legacyDb.close();
        }
    });

    it('preserves user-hidden state while marking an earlier pre-release revocation candidate', () => {
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
                is_hidden INTEGER DEFAULT 0,
                granted_by_admin INTEGER NOT NULL DEFAULT 0
              );
              INSERT INTO providers VALUES (10, 1);
              INSERT INTO provider_channels VALUES (20, 10);
              INSERT INTO user_categories VALUES (30, 2);
              INSERT INTO user_channels VALUES (40, 30, 20, 1, 0);
            `);

            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(1);
            expect(legacyDb.prepare(`
              SELECT id, is_hidden, granted_by_admin, authorization_revoked
              FROM user_channels
            `).get()).toEqual({
              id: 40,
              is_hidden: 1,
              granted_by_admin: 0,
              authorization_revoked: 1,
            });

            legacyDb.prepare(`
              UPDATE user_channels
              SET granted_by_admin = 1, authorization_revoked = 0
              WHERE id = 40
            `).run();
            migrateUserChannelAdminGrants(legacyDb);
            expect(legacyDb.prepare('SELECT id FROM authorized_user_channels').get()).toBeUndefined();

            legacyDb.prepare('UPDATE user_channels SET is_hidden = 0 WHERE id = 40').run();
            expect(legacyDb.prepare('SELECT id FROM authorized_user_channels').get()).toEqual({ id: 40 });
        } finally {
            legacyDb.close();
        }
    });

    it('rebuilds the episode cache with series-scoped uniqueness exactly once', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec(`
              CREATE TABLE sync_configs (id INTEGER PRIMARY KEY);
              CREATE TABLE provider_series_episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_key TEXT NOT NULL,
                series_remote_id INTEGER NOT NULL,
                remote_episode_id INTEGER NOT NULL,
                UNIQUE(source_key, remote_episode_id)
              );
              CREATE TABLE provider_series_state (
                source_key TEXT NOT NULL,
                series_remote_id INTEGER NOT NULL,
                PRIMARY KEY (source_key, series_remote_id)
              );
              INSERT INTO provider_series_episodes
                (source_key, series_remote_id, remote_episode_id)
              VALUES ('source', 10, 7);
            `);

            migrateSeriesEpisodes(legacyDb);
            expect(legacyDb.prepare('SELECT COUNT(*) AS count FROM provider_series_episodes').get().count).toBe(0);

            legacyDb.prepare(`
              INSERT INTO provider_series_episodes
                (source_key, series_remote_id, remote_episode_id)
              VALUES ('source', 10, 7), ('source', 11, 7)
            `).run();
            migrateSeriesEpisodes(legacyDb);

            expect(legacyDb.prepare(`
              SELECT series_remote_id, remote_episode_id
              FROM provider_series_episodes
              ORDER BY series_remote_id
            `).all()).toEqual([
                { series_remote_id: 10, remote_episode_id: 7 },
                { series_remote_id: 11, remote_episode_id: 7 }
            ]);
            expect(legacyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'series_episode_aliases'").get()).toBeTruthy();
            expect(legacyDb.prepare(`
              INSERT INTO series_episode_aliases
                (user_channel_id, source_key, series_remote_id, remote_episode_id)
              VALUES (1, 'source', 10, 7)
            `).run().lastInsertRowid).toBe(900000001);
        } finally {
            legacyDb.close();
        }
    });

    it('disables legacy cross-owner sync configs idempotently without changing IDs', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec(`
              CREATE TABLE providers (id INTEGER PRIMARY KEY, user_id INTEGER);
              CREATE TABLE sync_configs (
                id INTEGER PRIMARY KEY,
                provider_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                enabled INTEGER DEFAULT 1
              );
              INSERT INTO providers (id, user_id) VALUES (10, 1), (11, 2);
              INSERT INTO sync_configs (id, provider_id, user_id, enabled)
                VALUES (20, 10, 1, 1), (21, 11, 1, 1);
            `);

            expect(migrateSyncConfigAdminGrants(legacyDb)).toBe(1);
            expect(legacyDb.prepare('SELECT id, enabled, granted_by_admin FROM sync_configs ORDER BY id').all()).toEqual([
                { id: 20, enabled: 1, granted_by_admin: 0 },
                { id: 21, enabled: 0, granted_by_admin: 0 }
            ]);

            legacyDb.prepare('UPDATE sync_configs SET enabled = 1, granted_by_admin = 1 WHERE id = 21').run();
            expect(migrateSyncConfigAdminGrants(legacyDb)).toBe(0);
            expect(legacyDb.prepare('SELECT id, enabled, granted_by_admin FROM sync_configs WHERE id = 21').get()).toEqual({
                id: 21,
                enabled: 1,
                granted_by_admin: 1
            });
        } finally {
            legacyDb.close();
        }
    });
});
