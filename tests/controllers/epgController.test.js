
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import db, { initDb } from '../../src/database/db.js';
import * as epgController from '../../src/controllers/epgController.js';
import * as epgService from '../../src/services/epgService.js';
import * as helpers from '../../src/utils/helpers.js';

vi.mock('../../src/services/epgService.js', () => ({
    deleteEpgSourceData: vi.fn(),
    updateEpgSource: vi.fn(),
    updateProviderEpg: vi.fn()
}));

vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        isSafeUrl: vi.fn()
    };
});

describe('EPG Controller', () => {
    beforeAll(() => {
        initDb(true); // Initialize DB with tables
    });

    beforeEach(() => {
        db.prepare('DELETE FROM epg_sources').run();
        vi.clearAllMocks();
    });

    afterEach(() => {
        db.prepare('DELETE FROM epg_sources').run();
    });

    describe('createEpgSource', () => {
        it('should deny access if user is not admin', async () => {
            const req = { user: { is_admin: false }, body: {} };
            const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

            await epgController.createEpgSource(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
        });

        it('should validate required fields', async () => {
            const req = { user: { is_admin: true }, body: { name: 'Test' } }; // Missing URL
            const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

            await epgController.createEpgSource(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: 'name and url required' });
        });

        it('should block unsafe URLs', async () => {
            helpers.isSafeUrl.mockResolvedValue(false);
            const req = { user: { is_admin: true }, body: { name: 'Test', url: 'http://unsafe.local' } };
            const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

            await epgController.createEpgSource(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: 'invalid_url', message: 'URL is unsafe (blocked)' });
        });

        it('should create a valid EPG source', async () => {
            helpers.isSafeUrl.mockResolvedValue(true);
            const req = {
                user: { is_admin: true },
                body: { name: 'Test EPG', url: 'http://example.com/epg.xml', enabled: true, update_interval: 3600 }
            };
            const res = { json: vi.fn() };

            await epgController.createEpgSource(req, res);

            const source = db.prepare('SELECT * FROM epg_sources WHERE name = ?').get('Test EPG');
            expect(source).toBeDefined();
            expect(source.url).toBe('http://example.com/epg.xml');
            expect(source.enabled).toBe(1);
            expect(res.json).toHaveBeenCalledWith({ id: source.id });
        });
    });

    describe('updateEpgSourceEndpoint', () => {
        it('should update existing source fields', async () => {
            helpers.isSafeUrl.mockResolvedValue(true);
            const info = db.prepare('INSERT INTO epg_sources (name, url, enabled) VALUES (?, ?, ?)').run('Old Name', 'http://old.com', 1);
            const id = info.lastInsertRowid;

            const req = {
                user: { is_admin: true },
                params: { id },
                body: { name: 'New Name', url: 'http://new.com' }
            };
            const res = { json: vi.fn() };

            await epgController.updateEpgSourceEndpoint(req, res);

            const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(id);
            expect(source.name).toBe('New Name');
            expect(source.url).toBe('http://new.com');
            expect(res.json).toHaveBeenCalledWith({ success: true });
        });

        it('should block unsafe URLs during update', async () => {
            helpers.isSafeUrl.mockResolvedValue(false);
            const info = db.prepare('INSERT INTO epg_sources (name, url, enabled) VALUES (?, ?, ?)').run('Valid', 'http://valid.com', 1);
            const id = info.lastInsertRowid;

            const req = {
                user: { is_admin: true },
                params: { id },
                body: { url: 'http://unsafe.local' }
            };
            const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

            await epgController.updateEpgSourceEndpoint(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: 'invalid_url', message: 'URL is unsafe (blocked)' });

            const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(id);
            expect(source.url).toBe('http://valid.com'); // Should not change
        });
    });

    describe('deleteEpgSource', () => {
        it('should delete source and trigger data cleanup', async () => {
            const info = db.prepare('INSERT INTO epg_sources (name, url, enabled) VALUES (?, ?, ?)').run('To Delete', 'http://del.com', 1);
            const id = info.lastInsertRowid;

            const req = { user: { is_admin: true }, params: { id } };
            const res = { json: vi.fn() };

            await epgController.deleteEpgSource(req, res);

            const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(id);
            expect(source).toBeUndefined();
            expect(epgService.deleteEpgSourceData).toHaveBeenCalledWith(id, 'custom');
            expect(res.json).toHaveBeenCalledWith({ success: true });
        });
    });
});
