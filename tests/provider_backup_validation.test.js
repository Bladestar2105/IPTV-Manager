
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-fetch
vi.mock('node-fetch', () => ({
    default: vi.fn()
}));

// Mock bcrypt inside crypto.js by mocking crypto.js entirely
vi.mock('../src/utils/crypto.js', () => ({
    encrypt: vi.fn((val) => 'encrypted_' + val),
    decrypt: vi.fn((val) => val.replace('encrypted_', ''))
}));

const { mockPrepare, mockRun, mockGet, mockAll, mockExec, mockTransaction } = vi.hoisted(() => {
    const mockRun = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
    const mockGet = vi.fn();
    const mockAll = vi.fn();
    const mockPrepare = vi.fn().mockReturnValue({
        run: mockRun,
        get: mockGet,
        all: mockAll
    });
    const mockExec = vi.fn();
    const mockTransaction = vi.fn((fn) => fn);
    return { mockPrepare, mockRun, mockGet, mockAll, mockExec, mockTransaction };
});

vi.mock('../src/database/db.js', () => ({
    default: {
        prepare: mockPrepare,
        exec: mockExec,
        transaction: mockTransaction
    }
}));

// Mock helpers
vi.mock('../src/utils/helpers.js', async () => {
    return {
        isSafeUrl: vi.fn(async (url) => {
            if (url && url.includes('unsafe')) return false;
            return true;
        }),
        checkProviderExpiry: vi.fn(),
        isAdultCategory: vi.fn().mockReturnValue(false)
    };
});

// Mock other services
vi.mock('../src/services/epgService.js', () => ({
    updateProviderEpg: vi.fn().mockResolvedValue()
}));
vi.mock('../src/services/syncService.js', () => ({
    checkProviderExpiry: vi.fn(),
    performSync: vi.fn()
}));

// Mock constants
vi.mock('../src/config/constants.js', () => ({
    EPG_CACHE_DIR: '/tmp',
    DATA_DIR: '/tmp'
}));

import * as providerController from '../src/controllers/providerController.js';

describe('Provider Controller - Backup URLs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset default mock returns if needed
        mockPrepare.mockReturnValue({
            run: mockRun,
            get: mockGet,
            all: mockAll
        });
        mockRun.mockReturnValue({ lastInsertRowid: 1 });
    });

    it('createProvider should save backup_urls correctly', async () => {
        const req = {
            user: { is_admin: true },
            body: {
                name: 'Test Provider',
                url: 'http://test.com',
                username: 'user',
                password: 'password',
                backup_urls: ['http://backup1.com', 'http://backup2.com'],
                epg_url: 'http://epg.com'
            }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        await providerController.createProvider(req, res);

        expect(res.status).not.toHaveBeenCalledWith(400);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO providers'));
        expect(mockRun).toHaveBeenCalled();

        const calls = mockRun.mock.calls;
        const lastCall = calls[calls.length - 1];
        const backupUrlsSaved = lastCall[8];
        expect(backupUrlsSaved).toBe('["http://backup1.com","http://backup2.com"]');
    });

    it('createProvider should return 400 for unsafe backup URL', async () => {
        const req = {
            user: { is_admin: true },
            body: {
                name: 'Unsafe Provider',
                url: 'http://test.com',
                username: 'user',
                password: 'password',
                backup_urls: ['http://unsafe.com'],
                epg_url: 'http://epg.com'
            }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        await providerController.createProvider(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Backup URL is unsafe or invalid')
        }));
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('createProvider should return 400 for invalid format backup URL', async () => {
        const req = {
            user: { is_admin: true },
            body: {
                name: 'Invalid Provider',
                url: 'http://test.com',
                username: 'user',
                password: 'password',
                backup_urls: ['invalid-url'],
                epg_url: 'http://epg.com'
            }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        await providerController.createProvider(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Backup URL must start with http:// or https://')
        }));
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('updateProvider should update backup_urls correctly', async () => {
        const req = {
            user: { is_admin: true },
            params: { id: 1 },
            body: {
                name: 'Test Provider',
                url: 'http://test.com',
                username: 'user',
                password: 'password',
                backup_urls: ['http://updated1.com', 'http://updated2.com']
            }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        mockGet.mockReturnValue({
            id: 1,
            user_id: 1,
            password: 'encrypted_password',
            backup_urls: '[]'
        });

        await providerController.updateProvider(req, res);

        expect(res.status).not.toHaveBeenCalledWith(400);
        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE providers'));
        expect(mockRun).toHaveBeenCalled();

        const calls = mockRun.mock.calls;
        const lastCall = calls[calls.length - 1];
        const backupUrlsSaved = lastCall[8];
        expect(backupUrlsSaved).toBe('["http://updated1.com","http://updated2.com"]');
    });

    it('updateProvider should return 400 for unsafe backup URL', async () => {
        const req = {
            user: { is_admin: true },
            params: { id: 1 },
            body: {
                name: 'Unsafe Update',
                url: 'http://test.com',
                username: 'user',
                password: 'password',
                backup_urls: ['http://unsafe.com']
            }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis()
        };

        mockGet.mockReturnValue({
            id: 1,
            user_id: 1,
            password: 'encrypted_password',
            backup_urls: '[]'
        });

        await providerController.updateProvider(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Backup URL is unsafe or invalid')
        }));
        expect(mockRun).not.toHaveBeenCalled();
    });
});
