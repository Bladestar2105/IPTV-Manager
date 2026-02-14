import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { DATA_DIR } from '../config/constants.js';

const uploadDir = path.join(DATA_DIR, 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

export const fileFilter = (req, file, cb) => {
    // Accept encrypted binary, JSON, or gzip
    const allowedMimeTypes = [
        'application/octet-stream',
        'application/json',
        'application/gzip',
        'application/x-gzip',
        'application/zip',
        'application/x-zip-compressed'
    ];

    // Also check extensions as fallback (some browsers/OS might send different MIME types)
    const allowedExtensions = ['.bin', '.json', '.gz', '.enc'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
        cb(null, true);
    } else {
        // Log the rejected type for debugging
        console.warn(`[Upload] Rejected file: ${file.originalname} (${file.mimetype})`);
        cb(new Error('Invalid file type'));
    }
};

export const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: fileFilter
});
