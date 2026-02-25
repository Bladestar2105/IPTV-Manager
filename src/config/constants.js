import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = process.env.PORT || 3000;
// src/config/../../ -> root
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const EPG_CACHE_DIR = path.join(CACHE_DIR, 'epg');
export const EPG_DB_PATH = path.join(DATA_DIR, 'epg.db');
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
export const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 10;
export const AUTH_CACHE_TTL = 60000;
export const AUTH_CACHE_MAX_SIZE = 10000;
export const AUTH_CACHE_CLEANUP_INTERVAL = 300000; // 5 minutes
