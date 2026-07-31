import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import db, { initDb } from '../src/database/db.js';
import { encrypt, decrypt } from '../src/utils/crypto.js';
import {
    migrateProviderPasswords,
    migrateOtpSecrets,
    migrateSeriesEpisodes,
    migrateUserChannelMappingId,
    migrateProviderSyncState,
    migrateUserChannelMappingBackfillV1,
    migrateUserChannelDeduplicationV1,
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

    it('adds the nullable mapping ownership column idempotently', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec('CREATE TABLE user_channels (id INTEGER PRIMARY KEY, user_category_id INTEGER, provider_channel_id INTEGER)');
            migrateUserChannelMappingId(legacyDb);
            migrateUserChannelMappingId(legacyDb);
            expect(legacyDb.prepare('PRAGMA table_info(user_channels)').all().map(column => column.name))
              .toContain('mapping_id');
            expect(legacyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_channels_mapping'").get())
              .toEqual({ name: 'idx_user_channels_mapping' });
        } finally {
            legacyDb.close();
        }
    });

    it('creates persistent provider snapshot state idempotently', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec('CREATE TABLE providers (id INTEGER PRIMARY KEY)');
            migrateProviderSyncState(legacyDb);
            migrateProviderSyncState(legacyDb);
            expect(legacyDb.prepare('PRAGMA table_info(provider_sync_state)').all().map(column => column.name))
              .toEqual(['provider_id', 'stream_type', 'empty_snapshot_count', 'last_nonempty_count', 'last_snapshot_at']);
        } finally {
            legacyDb.close();
        }
    });

    it('backfills only unambiguous legacy mapping ownership and records a marker', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec(`
              CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
              CREATE TABLE providers (id INTEGER PRIMARY KEY, user_id INTEGER);
              CREATE TABLE provider_channels (id INTEGER PRIMARY KEY, provider_id INTEGER, original_category_id INTEGER, stream_type TEXT);
              CREATE TABLE user_categories (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT);
              CREATE TABLE category_mappings (
                id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER,
                provider_category_id INTEGER, provider_category_name TEXT,
                user_category_id INTEGER, category_type TEXT
              );
              CREATE TABLE user_channels (
                id INTEGER PRIMARY KEY, user_category_id INTEGER, provider_channel_id INTEGER,
                mapping_id INTEGER
              );
              INSERT INTO providers VALUES (1, 1), (2, 9);
              INSERT INTO provider_channels VALUES
                (10, 1, 100, 'live'), (11, 1, 200, 'live'), (12, 2, 100, 'live'),
                (13, 1, 300, 'live'), (14, 1, 400, 'live'), (15, 1, 500, 'live');
              INSERT INTO user_categories VALUES
                (20, 2, 'live'), (21, 2, 'radio'), (22, 2, 'movie'), (23, 2, 'live');
              INSERT INTO category_mappings VALUES
                (100, 1, 2, 100, 'Live', 20, 'live'),
                (101, 1, 2, 200, 'Radio', 21, 'radio'),
                (102, 1, 2, 300, 'Ambiguous A', 20, 'live'),
                (103, 1, 2, 300, 'Ambiguous B', 20, 'live'),
                (105, 1, 2, 400, 'Wrong type', 22, 'movie'),
                (106, 1, 2, 500, 'Unmatched', 23, 'live'),
                (107, 1, 2, 600, 'Cross owner', 23, 'live');
              INSERT INTO user_channels (id, user_category_id, provider_channel_id, mapping_id) VALUES
                (201, 20, 10, NULL), (202, 21, 11, NULL), (203, 20, 13, NULL),
                (204, 20, 12, NULL), (205, 22, 14, NULL), (206, 23, 15, NULL);
            `);

            const result = migrateUserChannelMappingBackfillV1(legacyDb);
            expect(result).toEqual({ assigned: 3, ambiguous: 1, unmatched: 2, skipped: false });
            expect(legacyDb.prepare('SELECT id, mapping_id FROM user_channels ORDER BY id').all()).toEqual([
              { id: 201, mapping_id: 100 },
              { id: 202, mapping_id: 101 },
              { id: 203, mapping_id: null },
              { id: 204, mapping_id: null },
              { id: 205, mapping_id: null },
              { id: 206, mapping_id: 106 }
            ]);
            expect(legacyDb.prepare("SELECT value FROM settings WHERE key = 'user_channel_mapping_backfill_v1'").get()).toBeTruthy();
            expect(migrateUserChannelMappingBackfillV1(legacyDb)).toEqual({ assigned: 0, ambiguous: 0, unmatched: 0, skipped: true });
        } finally {
            legacyDb.close();
        }
    });

    it('deduplicates assignments, rebinds aliases, and creates a unique index idempotently', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.pragma('foreign_keys = ON');
            legacyDb.exec(`
              CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
              CREATE TABLE user_channels (
                id INTEGER PRIMARY KEY, user_category_id INTEGER, provider_channel_id INTEGER,
                sort_order INTEGER DEFAULT 0, custom_name TEXT DEFAULT '', is_hidden INTEGER DEFAULT 0,
                mapping_id INTEGER, granted_by_admin INTEGER DEFAULT 0, authorization_revoked INTEGER DEFAULT 0
              );
              CREATE TABLE series_episode_aliases (
                id INTEGER PRIMARY KEY,
                user_channel_id INTEGER NOT NULL,
                source_key TEXT NOT NULL,
                series_remote_id INTEGER NOT NULL,
                remote_episode_id INTEGER NOT NULL,
                UNIQUE(user_channel_id, source_key, series_remote_id, remote_episode_id),
                FOREIGN KEY (user_channel_id) REFERENCES user_channels(id) ON DELETE CASCADE
              );
              INSERT INTO user_channels VALUES
                (1, 10, 20, 8, '', 0, 7, 1, 0),
                (2, 10, 20, 2, 'Manual', 1, NULL, 0, 0),
                (3, 11, 21, 9, 'Mapped', 0, 8, 0, 1),
                (4, 11, 21, 3, '', 0, 9, 0, 0);
              INSERT INTO series_episode_aliases (id, user_channel_id, source_key, series_remote_id, remote_episode_id) VALUES
                (900000005, 2, 'source', 20, 1),
                (900000006, 1, 'source', 20, 1),
                (900000007, 1, 'source', 20, 2),
                (900000008, 3, 'source', 21, 1);
            `);

            expect(migrateUserChannelDeduplicationV1(legacyDb)).toEqual({ merged: 2, skipped: false });
            expect(legacyDb.prepare('SELECT id, mapping_id, is_hidden, custom_name, sort_order FROM user_channels ORDER BY id').all()).toEqual([
              { id: 2, mapping_id: null, is_hidden: 1, custom_name: 'Manual', sort_order: 2 },
              { id: 3, mapping_id: 8, is_hidden: 0, custom_name: 'Mapped', sort_order: 3 }
            ]);
            expect(legacyDb.prepare('SELECT id, user_channel_id, remote_episode_id FROM series_episode_aliases ORDER BY id').all()).toEqual([
              { id: 900000005, user_channel_id: 2, remote_episode_id: 1 },
              { id: 900000007, user_channel_id: 2, remote_episode_id: 2 },
              { id: 900000008, user_channel_id: 3, remote_episode_id: 1 }
            ]);
            expect(legacyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_user_channels_category_provider'").get())
              .toEqual({ name: 'uq_user_channels_category_provider' });
            expect(migrateUserChannelDeduplicationV1(legacyDb)).toEqual({ merged: 0, skipped: true });
        } finally {
            legacyDb.close();
        }
    });

    it('should revoke legacy ownership mismatches idempotently without changing IDs', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec(`
              CREATE TABLE providers (id INTEGER PRIMARY KEY, user_id INTEGER);
              CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
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

            expect(legacyDb.prepare("SELECT value FROM settings WHERE key = 'user_channel_authorization_v1'").get())
              .toEqual({ value: 'true' });
            legacyDb.exec(`
              CREATE TRIGGER reject_repeated_authorization_backfill
              BEFORE UPDATE ON user_channels
              BEGIN
                SELECT RAISE(FAIL, 'authorization backfill repeated');
              END;
            `);
            expect(migrateUserChannelAdminGrants(legacyDb)).toBe(0);
            legacyDb.exec('DROP TRIGGER reject_repeated_authorization_backfill');
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
              CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
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
              CREATE TABLE user_channels (id INTEGER PRIMARY KEY);
              INSERT INTO user_channels (id) VALUES (1);
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

    it('rebuilds episode aliases with cascade, preserves valid IDs, and removes orphans idempotently', () => {
        const legacyDb = new Database(':memory:');
        try {
            legacyDb.exec(`
              CREATE TABLE sync_configs (id INTEGER PRIMARY KEY);
              CREATE TABLE user_channels (id INTEGER PRIMARY KEY);
              INSERT INTO user_channels (id) VALUES (1), (2);
              CREATE TABLE series_episode_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id >= 900000000 AND id < 1000000000),
                user_channel_id INTEGER NOT NULL,
                source_key TEXT NOT NULL,
                series_remote_id INTEGER NOT NULL,
                remote_episode_id INTEGER NOT NULL,
                UNIQUE(user_channel_id, source_key, series_remote_id, remote_episode_id)
              );
              INSERT INTO series_episode_aliases
                (id, user_channel_id, source_key, series_remote_id, remote_episode_id)
              VALUES
                (900000005, 1, 'source', 10, 7),
                (900000006, 99, 'source', 10, 8);
            `);
            legacyDb.pragma('foreign_keys = ON');

            migrateSeriesEpisodes(legacyDb);

            expect(legacyDb.prepare(`
              SELECT id, user_channel_id FROM series_episode_aliases ORDER BY id
            `).all()).toEqual([{ id: 900000005, user_channel_id: 1 }]);
            expect(legacyDb.prepare("PRAGMA foreign_key_list('series_episode_aliases')").all()).toEqual(
              expect.arrayContaining([expect.objectContaining({
                table: 'user_channels', from: 'user_channel_id', to: 'id', on_delete: 'CASCADE'
              })])
            );

            migrateSeriesEpisodes(legacyDb);
            expect(legacyDb.prepare('SELECT COUNT(*) AS count FROM series_episode_aliases').get().count).toBe(1);

            const nextId = legacyDb.prepare(`
              INSERT INTO series_episode_aliases
                (user_channel_id, source_key, series_remote_id, remote_episode_id)
              VALUES (2, 'source', 10, 9)
            `).run().lastInsertRowid;
            expect(nextId).toBeGreaterThanOrEqual(900000000);
            expect(nextId).toBeLessThan(1000000000);

            legacyDb.prepare('DELETE FROM user_channels WHERE id = 1').run();
            expect(legacyDb.prepare('SELECT id FROM series_episode_aliases WHERE id = 900000005').get()).toBeUndefined();
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
