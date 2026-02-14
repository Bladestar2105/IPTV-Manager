
import { describe, it, expect, vi } from 'vitest';
import { fileFilter } from '../src/middleware/upload.js';

describe('Upload Middleware - fileFilter', () => {
    it('should accept allowed mime types', () => {
        const allowedTypes = [
            'application/octet-stream',
            'application/json',
            'application/gzip',
            'application/x-gzip',
            'application/zip',
            'application/x-zip-compressed'
        ];

        allowedTypes.forEach(type => {
            const file = { mimetype: type, originalname: 'test.dat' };
            const cb = vi.fn();
            fileFilter({}, file, cb);
            expect(cb).toHaveBeenCalledWith(null, true);
        });
    });

    it('should accept allowed extensions regardless of mime type', () => {
        const allowedExtensions = ['.bin', '.json', '.gz', '.enc'];

        allowedExtensions.forEach(ext => {
            const file = { mimetype: 'application/unknown', originalname: `file${ext}` };
            const cb = vi.fn();
            fileFilter({}, file, cb);
            expect(cb).toHaveBeenCalledWith(null, true);
        });
    });

    it('should accept allowed extensions with mixed case', () => {
        const file = { mimetype: 'application/unknown', originalname: 'file.BIN' };
        const cb = vi.fn();
        fileFilter({}, file, cb);
        expect(cb).toHaveBeenCalledWith(null, true);
    });

    it('should reject invalid mime type AND extension', () => {
        const file = { mimetype: 'image/png', originalname: 'image.png' };
        const cb = vi.fn();
        fileFilter({}, file, cb);
        expect(cb).toHaveBeenCalledWith(expect.any(Error));
        expect(cb.mock.calls[0][0].message).toBe('Invalid file type');
    });

    it('should log rejected files', () => {
        const consoleSpy = vi.spyOn(console, 'warn');
        const file = { mimetype: 'text/plain', originalname: 'malicious.txt' };
        const cb = vi.fn();
        fileFilter({}, file, cb);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected file: malicious.txt (text/plain)'));
        consoleSpy.mockRestore();
    });
});
