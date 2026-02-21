
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import { encryptWithPassword, encrypt } from '../../src/utils/crypto.js';

// 1. Mock DB with in-memory instance
vi.mock('../../src/database/db.js', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    return { default: db };
});

// Import db AFTER mocking (it will get the mock)
import db from '../../src/database/db.js';

// Mock other dependencies
vi.mock('../../src/services/streamManager.js', () => ({
    default: { getAll: vi.fn(() => []) }
}));
vi.mock('../../src/services/syncService.js', () => ({
    calculateNextSync: vi.fn(() => 0)
}));

// 3. Import Controllers (System under test)
import * as systemController from '../../src/controllers/systemController.js';
import * as userController from '../../src/controllers/userController.js';

// Schema Initialization
function initSchema() {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      webui_access INTEGER DEFAULT 1,
      hdhr_enabled INTEGER DEFAULT 0,
      hdhr_token TEXT,
      max_connections INTEGER DEFAULT 0,
      otp_enabled INTEGER DEFAULT 0,
      otp_secret TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      epg_url TEXT,
      user_id INTEGER,
      epg_update_interval INTEGER DEFAULT 86400,
      epg_enabled INTEGER DEFAULT 1,
      user_agent TEXT,
      backup_urls TEXT,
      expiry_date INTEGER,
      max_connections INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS provider_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER,
      remote_stream_id INTEGER,
      name TEXT,
      stream_type TEXT,
      original_category_id INTEGER,
      logo TEXT,
      epg_channel_id TEXT,
      original_sort_order INTEGER,
      tv_archive INTEGER,
      tv_archive_duration INTEGER,
      mime_type TEXT,
      metadata TEXT,
      rating TEXT,
      rating_5based REAL,
      added TEXT,
      plot TEXT,
      "cast" TEXT,
      director TEXT,
      genre TEXT,
      releaseDate TEXT,
      youtube_trailer TEXT,
      episode_run_time TEXT
    );

    CREATE TABLE IF NOT EXISTS epg_channel_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_channel_id INTEGER,
      epg_channel_id TEXT
    );

    CREATE TABLE IF NOT EXISTS user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      sort_order INTEGER,
      is_adult INTEGER,
      type TEXT
    );

    CREATE TABLE IF NOT EXISTS category_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER,
      user_id INTEGER,
      provider_category_id INTEGER,
      provider_category_name TEXT,
      user_category_id INTEGER,
      auto_created INTEGER,
      category_type TEXT
    );

    CREATE TABLE IF NOT EXISTS user_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_category_id INTEGER,
        provider_channel_id INTEGER,
        sort_order INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER,
        user_id INTEGER,
        enabled INTEGER,
        sync_interval TEXT,
        last_sync INTEGER,
        next_sync INTEGER,
        auto_add_categories INTEGER,
        auto_add_channels INTEGER
    );
    `);
}

describe('System - Provider Data Integrity', () => {
    beforeAll(() => {
        initSchema();
    });

    beforeEach(() => {
        db.exec('DELETE FROM providers');
        db.exec('DELETE FROM users');
        db.exec('DELETE FROM admin_users');
        // Create Admin User
        db.prepare("INSERT INTO admin_users (username) VALUES ('admin')").run();
    });

    it('should correctly import provider data including backup_urls and max_connections', async () => {
        // Prepare Export Data
        const exportData = {
            version: 1,
            users: [
                { id: 1, username: 'testuser', password: 'pw', is_active: 1 }
            ],
            providers: [
                {
                    id: 10,
                    user_id: 1,
                    name: 'Provider A',
                    url: 'http://prov.com',
                    username: 'u',
                    password: 'p',
                    backup_urls: JSON.stringify(['http://backup1.com', 'http://backup2.com']),
                    user_agent: 'CustomUA',
                    max_connections: 5
                }
            ],
            categories: [],
            channels: [],
            mappings: [],
            sync_configs: []
        };

        const jsonStr = JSON.stringify(exportData);
        const compressed = zlib.gzipSync(jsonStr);
        const encrypted = encryptWithPassword(compressed, 'password123');

        // Mock Request
        const req = {
            user: { is_admin: true },
            body: { password: 'password123' },
            file: { path: 'temp_import.bin' }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        // Mock fs.readFileSync to return encrypted buffer
        vi.spyOn(fs, 'readFileSync').mockReturnValue(encrypted);
        vi.spyOn(fs, 'existsSync').mockReturnValue(true); // for unlink
        vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

        // Run Import
        await systemController.importData(req, res);

        // Verify Response
        expect(res.status).not.toHaveBeenCalledWith(400);
        expect(res.status).not.toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

        // Verify DB
        const providers = db.prepare('SELECT * FROM providers').all();
        expect(providers).toHaveLength(1);
        const p = providers[0];

        expect(p.name).toBe('Provider A');
        expect(p.backup_urls).toBe(JSON.stringify(['http://backup1.com', 'http://backup2.com']));
        expect(p.user_agent).toBe('CustomUA');
        expect(p.max_connections).toBe(5);
    });

    it('should correctly copy provider data when using Copy From User', async () => {
        // 1. Setup Source User and Provider
        const sourceUser = db.prepare("INSERT INTO users (username, password) VALUES ('source', 'pass')").run();
        const sourceUserId = sourceUser.lastInsertRowid;

        const backupUrls = JSON.stringify(['http://source-backup.com']);
        db.prepare(`
            INSERT INTO providers (name, url, username, password, user_id, backup_urls, user_agent, max_connections)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run('Source Prov', 'http://source.com', 'u', 'p', sourceUserId, backupUrls, 'SourceUA', 10);

        // 2. Mock Request for createUser (Copy)
        const req = {
            user: { is_admin: true },
            body: {
                username: 'newuser',
                password: 'password123',
                copy_from_user_id: sourceUserId,
                max_connections: 0
            }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        // Run Create User
        await userController.createUser(req, res);

        // Verify Response
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'User created successfully' }));

        // Verify DB
        const newUser = db.prepare("SELECT * FROM users WHERE username = 'newuser'").get();
        expect(newUser).toBeDefined();

        const newProviders = db.prepare('SELECT * FROM providers WHERE user_id = ?').all(newUser.id);
        expect(newProviders).toHaveLength(1);
        const p = newProviders[0];

        expect(p.name).toBe('Source Prov');
        expect(p.backup_urls).toBe(backupUrls);
        expect(p.user_agent).toBe('SourceUA');
        expect(p.max_connections).toBe(10);
    });
});
