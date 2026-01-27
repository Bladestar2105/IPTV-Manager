import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '../../');
export const CACHE_DIR = path.join(ROOT_DIR, 'cache');
export const EPG_CACHE_DIR = path.join(CACHE_DIR, 'epg');
