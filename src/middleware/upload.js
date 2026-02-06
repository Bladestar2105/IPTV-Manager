import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { DATA_DIR } from '../config/constants.js';

const uploadDir = path.join(DATA_DIR, 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

export const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        // Accept encrypted binary or JSON
        if (file.mimetype === 'application/octet-stream' || file.mimetype === 'application/json' || file.mimetype === 'application/gzip' || file.mimetype === 'application/x-gzip') {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});
