import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { DATA_DIR } from '../config/constants.js';

const uploadDir = path.join(DATA_DIR, 'temp_uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

export const upload = multer({ dest: uploadDir });
