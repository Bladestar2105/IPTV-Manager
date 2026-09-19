import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { resolveBudget } from '../utils/env.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Not merely cosmetic: `app.listen` reads a string that is not a number as a
// *pipe path*, so `PORT=3000x` starts a listener on a unix socket of that name
// in the working directory, logs the usual "listening" line and is reachable by
// nothing. 65535 is the protocol's own ceiling.
export const PORT = resolveBudget(process.env.PORT, 3000, 1, 65535, 'PORT');
// src/config/../../ -> root
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const EPG_CACHE_DIR = path.join(CACHE_DIR, 'epg');
export const EPG_DB_PATH = path.join(DATA_DIR, 'epg.db');
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
// bcrypt rewrites anything below 4 to 4 without saying so, and `parseInt` reads
// a typo such as `1O` as 1 — which is how a cost factor of 10 becomes a cost
// factor of 4, sixty-four times cheaper to brute-force, with nothing in the log
// and nothing in the configuration to read it off. A negative value is worse
// still: bcrypt rejects the salt, so every hash throws at runtime, complaining
// about a salt rather than about the setting. 31 is bcrypt's own ceiling.
export const BCRYPT_ROUNDS = resolveBudget(process.env.BCRYPT_ROUNDS, 10, 4, 31, 'BCRYPT_ROUNDS');
export const AUTH_CACHE_TTL = 60000;
export const AUTH_CACHE_MAX_SIZE = 10000;
export const AUTH_CACHE_CLEANUP_INTERVAL = 300000; // 5 minutes
