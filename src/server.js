/**
 * Author: Bladestar2105
 * License: MIT
 */
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import Database from 'better-sqlite3';
import { Xtream } from '@iptv/xtream-api';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import dotenv from 'dotenv';
import crypto from 'crypto';
import multer from 'multer';
import zlib from 'zlib';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { cleanName, levenshtein } from './epg_utils.js';

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// Trust Proxy Configuration
if (process.env.TRUST_PROXY) {
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy.toLowerCase() === 'true') {
    app.set('trust proxy', true);
  } else if (trustProxy.toLowerCase() === 'false') {
    app.set('trust proxy', false);
  } else if (!isNaN(trustProxy)) {
    app.set('trust proxy', parseInt(trustProxy));
  } else {
    // String (IPs, 'loopback', 'linklocal', etc.)
    app.set('trust proxy', trustProxy);
  }
}

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../');

// Ensure Data Directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Security configuration
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 10;

// Encryption Configuration
let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyFile)) {
    ENCRYPTION_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  } else {
    ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, ENCRYPTION_KEY);
    console.log('🔐 Generated new unique encryption key and saved to secret.key');
  }
}
// Ensure key is 32 bytes for AES-256
if (Buffer.from(ENCRYPTION_KEY, 'hex').length !== 32) {
  // Hash it if it's not the right length/format
  ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest('hex');
}

function encrypt(text) {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) {
    console.error('Encryption error:', e);
    return text;
  }
}

function decrypt(text) {
  if (!text) return text;
  try {
    const textParts = text.split(':');
    if (textParts.length !== 2) return text;
    const iv = Buffer.from(textParts[0], 'hex');
    const encryptedText = Buffer.from(textParts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return text;
  }
}

// Export/Import Encryption Helpers
function encryptWithPassword(dataBuffer, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: Salt(16) + IV(12) + Tag(16) + EncryptedData
  return Buffer.concat([salt, iv, tag, encrypted]);
}

function decryptWithPassword(encryptedBuffer, password) {
  const salt = encryptedBuffer.subarray(0, 16);
  const iv = encryptedBuffer.subarray(16, 28);
  const tag = encryptedBuffer.subarray(28, 44);
  const data = encryptedBuffer.subarray(44);

  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// Create cache directories
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const EPG_CACHE_DIR = path.join(CACHE_DIR, 'epg');
// Picon caching removed - using direct URLs for better performance

// Ensure Cache Directories exist
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(EPG_CACHE_DIR)) fs.mkdirSync(EPG_CACHE_DIR, { recursive: true });

// Multer Setup for Import
const upload = multer({ dest: path.join(DATA_DIR, 'temp_uploads') });
if (!fs.existsSync(path.join(DATA_DIR, 'temp_uploads'))) {
    fs.mkdirSync(path.join(DATA_DIR, 'temp_uploads'), { recursive: true });
}

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "http:", "https:"],
      connectSrc: ["'self'", "http:", "https:"],
      mediaSrc: ["'self'", "blob:", "http:", "https:"],
      workerSrc: ["'self'", "blob:"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false
}));

// Rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 attempts (Relaxed to allow DB-based custom blocking to take precedence)
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(bodyParser.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || '*',
  credentials: true
}));

// Custom morgan token to redact sensitive info
morgan.token('url', (req, res) => {
  let url = req.originalUrl || req.url;
  // Redact password in /live/ path
  url = url.replace(/\/live\/([^/]+)\/([^/]+)\//, '/live/$1/********.redacted/');
  // Redact password query param
  url = url.replace(/([?&])password=[^&]*/i, '$1password=********');
  return url;
});

app.use(morgan(':method :url :status :response-time ms - :res[content-length]'));

// IP Blocking Middleware
app.use(async (req, res, next) => {
  const ip = req.ip;
  const now = Math.floor(Date.now() / 1000);

  try {
    // 1. Check Whitelist
    const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);
    if (whitelisted) return next();

    // 2. Check Blocklist
    const blocked = db.prepare('SELECT * FROM blocked_ips WHERE ip = ?').get(ip);
    if (blocked) {
      if (blocked.expires_at > now) {
        console.warn(`⛔ IP Blocked: ${ip} (Reason: ${blocked.reason})`);
        return res.status(403).send('Access Denied');
      } else {
        // Expired, remove it
        db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(blocked.id);
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_unblocked', 'Block expired', now);
      }
    }
  } catch (e) {
    console.error('IP Check Error:', e);
  }
  next();
});

app.use('/api', apiLimiter);

// Global API Authentication
app.use('/api', (req, res, next) => {
  // Allow CORS preflight
  if (req.method === 'OPTIONS') return next();
  // Public endpoints
  if (req.path === '/login' || req.path === '/login/' || req.path === '/client-logs' || req.path === '/player/playlist') return next();

  authenticateToken(req, res, next);
});

app.use(express.static(path.join(__dirname, '../public')));
// Cache folder should not be publicly accessible via static route
// EPG content is served via /xmltv.php which handles authentication
// app.use('/cache', express.static(path.join(__dirname, '../cache')));

// DB
const db = new Database(path.join(DATA_DIR, 'db.sqlite'));
// Enable foreign keys
db.pragma('foreign_keys = ON');
// Performance tuning
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// DB Init
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      epg_url TEXT,
      user_id INTEGER,
      epg_update_interval INTEGER DEFAULT 86400,
      epg_enabled INTEGER DEFAULT 1
    );
    
    CREATE TABLE IF NOT EXISTS provider_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      remote_stream_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      original_category_id INTEGER DEFAULT 0,
      logo TEXT DEFAULT '',
      stream_type TEXT DEFAULT 'live',
      epg_channel_id TEXT DEFAULT '',
      original_sort_order INTEGER DEFAULT 0,
      tv_archive INTEGER DEFAULT 0,
      tv_archive_duration INTEGER DEFAULT 0,
      UNIQUE(provider_id, remote_stream_id)
    );
    
    CREATE TABLE IF NOT EXISTS stream_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      views INTEGER DEFAULT 0,
      last_viewed INTEGER DEFAULT 0,
      FOREIGN KEY (channel_id) REFERENCES provider_channels(id)
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    
    CREATE TABLE IF NOT EXISTS temporary_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );
    
    CREATE TABLE IF NOT EXISTS user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_adult INTEGER DEFAULT 0,
      type TEXT DEFAULT 'live'
    );
    
    CREATE TABLE IF NOT EXISTS user_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_category_id INTEGER NOT NULL,
      provider_channel_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS sync_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      sync_interval TEXT DEFAULT 'daily',
      last_sync INTEGER DEFAULT 0,
      next_sync INTEGER DEFAULT 0,
      auto_add_categories INTEGER DEFAULT 1,
      auto_add_channels INTEGER DEFAULT 1,
      FOREIGN KEY (provider_id) REFERENCES providers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      sync_time INTEGER NOT NULL,
      status TEXT NOT NULL,
      channels_added INTEGER DEFAULT 0,
      channels_updated INTEGER DEFAULT 0,
      categories_added INTEGER DEFAULT 0,
      error_message TEXT,
      FOREIGN KEY (provider_id) REFERENCES providers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS category_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider_category_id INTEGER NOT NULL,
      provider_category_name TEXT NOT NULL,
      user_category_id INTEGER,
      auto_created INTEGER DEFAULT 0,
      UNIQUE(provider_id, user_id, provider_category_id),
      FOREIGN KEY (provider_id) REFERENCES providers(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (user_category_id) REFERENCES user_categories(id)
    );
    
    CREATE TABLE IF NOT EXISTS epg_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_update INTEGER DEFAULT 0,
      update_interval INTEGER DEFAULT 86400,
      source_type TEXT DEFAULT 'custom',
      is_updating INTEGER DEFAULT 0,
      UNIQUE(url)
    );
    
    CREATE TABLE IF NOT EXISTS epg_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epg_source_id INTEGER,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      programme_data TEXT,
      last_update INTEGER DEFAULT 0,
      FOREIGN KEY (epg_source_id) REFERENCES epg_sources(id)
    );

    CREATE TABLE IF NOT EXISTS epg_channel_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_channel_id INTEGER NOT NULL UNIQUE,
      epg_channel_id TEXT NOT NULL,
      FOREIGN KEY (provider_channel_id) REFERENCES provider_channels(id)
    );
    
    -- Security Tables
    CREATE TABLE IF NOT EXISTS security_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocked_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL UNIQUE,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS whitelisted_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Picon cache table removed - using direct URLs for better performance

    -- Settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Client Logs
    CREATE TABLE IF NOT EXISTS client_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'error',
      message TEXT,
      timestamp INTEGER NOT NULL,
      user_agent TEXT,
      stack TEXT
    );
  `);

  // Indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pc_prov_type ON provider_channels(provider_id, stream_type);
    CREATE INDEX IF NOT EXISTS idx_pc_name ON provider_channels(name);
  `);

  console.log("✅ Database OK");
  
  // Create default admin user if no users exist
  await createDefaultAdmin();

  // Migrate providers schema
  migrateProvidersSchema();
  migrateChannelsSchema();
  migrateChannelsSchemaExtended();
  migrateCategoriesSchema();
  migrateChannelsSchemaV2();
  migrateUserCategoriesType();

  // Migrate passwords
  migrateProviderPasswords();
} catch (e) {
  console.error("❌ DB Error:", e.message);
  process.exit(1);
}

function migrateProvidersSchema() {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('user_id')) {
      db.exec('ALTER TABLE providers ADD COLUMN user_id INTEGER');
      console.log('✅ DB Migration: user_id column added to providers');
    }

    if (!columns.includes('epg_update_interval')) {
      db.exec('ALTER TABLE providers ADD COLUMN epg_update_interval INTEGER DEFAULT 86400');
      console.log('✅ DB Migration: epg_update_interval column added to providers');
    }

    if (!columns.includes('epg_enabled')) {
      db.exec('ALTER TABLE providers ADD COLUMN epg_enabled INTEGER DEFAULT 1');
      console.log('✅ DB Migration: epg_enabled column added to providers');
    }
  } catch (e) {
    console.error('Schema migration error:', e);
  }
}

function migrateChannelsSchema() {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(provider_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('original_sort_order')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN original_sort_order INTEGER DEFAULT 0');
      console.log('✅ DB Migration: original_sort_order column added to provider_channels');
    }
  } catch (e) {
    console.error('Channel Schema migration error:', e);
  }
}

function migrateChannelsSchemaExtended() {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(provider_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('tv_archive')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN tv_archive INTEGER DEFAULT 0');
      console.log('✅ DB Migration: tv_archive column added to provider_channels');
    }

    if (!columns.includes('tv_archive_duration')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN tv_archive_duration INTEGER DEFAULT 0');
      console.log('✅ DB Migration: tv_archive_duration column added to provider_channels');
    }
  } catch (e) {
    console.error('Channel Extended Schema migration error:', e);
  }
}

function migrateCategoriesSchema() {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(category_mappings)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('category_type')) {
       console.log('🔄 Migrating category_mappings table schema...');

       db.transaction(() => {
           // Rename old table
           db.prepare("ALTER TABLE category_mappings RENAME TO category_mappings_old").run();

           // Create new table with new constraint and column
           db.prepare(`
            CREATE TABLE category_mappings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              provider_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              provider_category_id INTEGER NOT NULL,
              provider_category_name TEXT NOT NULL,
              user_category_id INTEGER,
              auto_created INTEGER DEFAULT 0,
              category_type TEXT DEFAULT 'live',
              UNIQUE(provider_id, user_id, provider_category_id, category_type),
              FOREIGN KEY (provider_id) REFERENCES providers(id),
              FOREIGN KEY (user_id) REFERENCES users(id),
              FOREIGN KEY (user_category_id) REFERENCES user_categories(id)
            )
           `).run();

           // Copy data
           db.prepare(`
             INSERT INTO category_mappings (id, provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
             SELECT id, provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, 'live'
             FROM category_mappings_old
           `).run();

           // Drop old table
           db.prepare("DROP TABLE category_mappings_old").run();
       })();

       console.log('✅ category_mappings table migrated');
    }
  } catch (e) {
    console.error('Category Schema migration error:', e);
  }
}

function migrateChannelsSchemaV2() {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(provider_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('metadata')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN metadata TEXT');
      console.log('✅ DB Migration: metadata column added to provider_channels');
    }

    if (!columns.includes('mime_type')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN mime_type TEXT');
      console.log('✅ DB Migration: mime_type column added to provider_channels');
    }
  } catch (e) {
    console.error('Channel Schema V2 migration error:', e);
  }
}

function migrateUserCategoriesType() {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(user_categories)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('type')) {
      db.exec("ALTER TABLE user_categories ADD COLUMN type TEXT DEFAULT 'live'");
      console.log('✅ DB Migration: type column added to user_categories');

      // Backfill type from mappings
      const stmt = db.prepare(`
        UPDATE user_categories
        SET type = (
          SELECT category_type
          FROM category_mappings
          WHERE category_mappings.user_category_id = user_categories.id
          LIMIT 1
        )
        WHERE EXISTS (
          SELECT 1
          FROM category_mappings
          WHERE category_mappings.user_category_id = user_categories.id
        )
      `);
      const info = stmt.run();
      console.log(`✅ DB Migration: Backfilled type for ${info.changes} user categories`);
    }
  } catch (e) {
    console.error('User Categories Type migration error:', e);
  }
}

function migrateProviderPasswords() {
  try {
    const providers = db.prepare('SELECT * FROM providers').all();
    let migrated = 0;
    for (const p of providers) {
      if (!p.password) continue;
      // Check if already encrypted (try to decrypt)
      if (p.password.includes(':')) {
         const val = decrypt(p.password);
         if (val !== p.password) continue; // Decryption successful, so it was already encrypted
      }
      // Encrypt
      const enc = encrypt(p.password);
      db.prepare('UPDATE providers SET password = ? WHERE id = ?').run(enc, p.id);
      migrated++;
    }
    if (migrated > 0) console.log(`🔐 Encrypted passwords for ${migrated} providers`);
  } catch (e) {
    console.error('Migration error:', e);
  }
}

// Migration: is_adult Spalte hinzufügen falls nicht vorhanden
try {
  db.exec('ALTER TABLE user_categories ADD COLUMN is_adult INTEGER DEFAULT 0');
  console.log('✅ DB Migration: is_adult column added');
} catch (e) {
  // Spalte existiert bereits
}

// Sync Scheduler
let syncIntervals = new Map();
// Active Streams Tracking
const activeStreams = new Map();

function calculateNextSync(interval) {
  const now = Math.floor(Date.now() / 1000);
  switch (interval) {
    case 'hourly': return now + 3600;
    case 'every_6_hours': return now + 21600;
    case 'every_12_hours': return now + 43200;
    case 'daily': return now + 86400;
    case 'weekly': return now + 604800;
    default: return now + 86400;
  }
}

async function performSync(providerId, userId, isManual = false) {
  const startTime = Math.floor(Date.now() / 1000);
  let channelsAdded = 0;
  let channelsUpdated = 0;
  let categoriesAdded = 0;
  let errorMessage = null;
  
  try {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider) throw new Error('Provider not found');
    
    // Decrypt password for usage
    provider.password = decrypt(provider.password);

    const config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?').get(providerId, userId);
    if (!config && !isManual) return;
    
    console.log(`🔄 Starting sync for provider ${provider.name} (user ${userId})`);
    
    // Fetch Data from Provider
    const xtream = createXtreamClient(provider);
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}`;
    
    let allChannels = [];
    let allCategories = [];

    // 1. Live
    try {
       let liveChans = [];
       try { liveChans = await xtream.getChannels(); }
       catch {
          const resp = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_live_streams`);
          liveChans = resp.ok ? await resp.json() : [];
       }
       // Normalize
       if (Array.isArray(liveChans)) {
         liveChans.forEach(c => {
           c.stream_type = 'live';
           c.category_type = 'live';
           allChannels.push(c);
         });
       }

       const respCat = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_live_categories`);
       if(respCat.ok) {
          const cats = await respCat.json();
          if (Array.isArray(cats)) {
            cats.forEach(c => { c.category_type = 'live'; allCategories.push(c); });
          }
       }
    } catch(e) { console.error('Live sync error:', e); }

    // 2. Movies (VOD)
    try {
       console.log('Fetching VOD streams...');
       const resp = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_vod_streams`);
       if(resp.ok) {
         const vods = await resp.json();
         console.log(`Fetched ${Array.isArray(vods) ? vods.length : 'invalid'} VODs`);
         if (Array.isArray(vods)) {
            vods.forEach(c => {
                c.stream_type = 'movie';
                c.category_type = 'movie';
                allChannels.push(c);
            });
         }
       } else {
         console.error(`VOD fetch failed: ${resp.status}`);
       }

       const respCat = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_vod_categories`);
       if(respCat.ok) {
          const cats = await respCat.json();
          if (Array.isArray(cats)) {
             cats.forEach(c => { c.category_type = 'movie'; allCategories.push(c); });
          }
       }
    } catch(e) { console.error('VOD sync error:', e); }

    // 3. Series
    try {
       const resp = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_series`);
       if(resp.ok) {
         const series = await resp.json();
         if (Array.isArray(series)) {
            series.forEach(c => {
                c.stream_type = 'series';
                c.category_type = 'series';
                // Map series fields to common format
                c.stream_id = c.series_id;
                c.stream_icon = c.cover;
                allChannels.push(c);
            });
         }
       }

       const respCat = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_series_categories`);
       if(respCat.ok) {
          const cats = await respCat.json();
          if (Array.isArray(cats)) {
             cats.forEach(c => { c.category_type = 'series'; allCategories.push(c); });
          }
       }
    } catch(e) { console.error('Series sync error:', e); }
    
    // Process categories and create mappings
    const categoryMap = new Map(); // Map<String, Int> -> "catId_type" -> userCatId
    
    // Performance Optimization: Pre-fetch all mappings to avoid N+1 queries
    const allMappings = db.prepare(`
      SELECT * FROM category_mappings
      WHERE provider_id = ? AND user_id = ?
    `).all(providerId, userId);

    const isFirstSync = allMappings.length === 0;
    
    // Create lookup map and populate initial categoryMap
    const mappingLookup = new Map(); // Key: "catId_type"
    for (const m of allMappings) {
      const key = `${m.provider_category_id}_${m.category_type || 'live'}`;
      mappingLookup.set(key, m);
      if (m.user_category_id) {
        categoryMap.set(key, m.user_category_id);
      }
    }
    
    // Prepare channel statements
    const insertChannel = db.prepare(`
      INSERT OR IGNORE INTO provider_channels
      (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order, tv_archive, tv_archive_duration, metadata, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const updateChannel = db.prepare(`
      UPDATE provider_channels 
      SET name = ?, original_category_id = ?, logo = ?, epg_channel_id = ?, original_sort_order = ?, tv_archive = ?, tv_archive_duration = ?, stream_type = ?, metadata = ?, mime_type = ?
      WHERE provider_id = ? AND remote_stream_id = ?
    `);
    
    // Optimized: Pre-fetch all channels to avoid N+1 query
    const existingChannels = db.prepare('SELECT remote_stream_id, id FROM provider_channels WHERE provider_id = ?').all(providerId);
    const existingMap = new Map();
    for (const row of existingChannels) {
      existingMap.set(row.remote_stream_id, row.id);
    }
    
    // Execute all DB operations in a single transaction
    db.transaction(() => {
      // 1. Process Categories
      for (const provCat of allCategories) {
        const catId = Number(provCat.category_id);
        const catName = provCat.category_name;
        const catType = provCat.category_type || 'live';
        const lookupKey = `${catId}_${catType}`;

        // Check if mapping exists using lookup
        let mapping = mappingLookup.get(lookupKey);

        // Auto-create categories if:
        // 1. No mapping exists AND not first sync AND auto_add enabled
        // This means it's a NEW category from the provider
        const shouldAutoCreate = config && config.auto_add_categories && !mapping && !isFirstSync;

        if (shouldAutoCreate) {
          // Create new user category
          const isAdult = isAdultCategory(catName) ? 1 : 0;
          const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
          const newSortOrder = (maxSort?.max_sort || -1) + 1;

          const catInfo = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)').run(userId, catName, isAdult, newSortOrder, catType);
          const newCategoryId = catInfo.lastInsertRowid;

          // Create new mapping (only for new categories)
          db.prepare(`
            INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
            VALUES (?, ?, ?, ?, ?, 1, ?)
          `).run(providerId, userId, catId, catName, newCategoryId, catType);

          categoryMap.set(lookupKey, newCategoryId);

          // Update lookup to prevent duplicates in current run
          mappingLookup.set(lookupKey, {
            provider_id: providerId,
            user_id: userId,
            provider_category_id: catId,
            provider_category_name: catName,
            user_category_id: newCategoryId,
            auto_created: 1,
            category_type: catType
          });

          categoriesAdded++;
          console.log(`  ✅ Created category: ${catName} (${catType}) (id=${newCategoryId})`);
        } else if (!mapping && isFirstSync) {
          // First sync: Create mapping without user category
          db.prepare(`
            INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
            VALUES (?, ?, ?, ?, NULL, 0, ?)
          `).run(providerId, userId, catId, catName, catType);

          // Update lookup to prevent duplicates in current run
          mappingLookup.set(lookupKey, {
            provider_id: providerId,
            user_id: userId,
            provider_category_id: catId,
            provider_category_name: catName,
            user_category_id: null,
            auto_created: 0,
            category_type: catType
          });

          console.log(`  📋 Registered category: ${catName} (${catType})`);
        }
      }

      // 2. Process Channels
      for (let i = 0; i < allChannels.length; i++) {
        const ch = allChannels[i];
        const sid = Number(ch.stream_id || ch.series_id || ch.id || 0);
        if (sid > 0) {
          const existingId = existingMap.get(sid);
          let provChannelId;
          
          const tvArchive = Number(ch.tv_archive) === 1 ? 1 : 0;
          const tvArchiveDuration = Number(ch.tv_archive_duration) || 0;
          const streamType = ch.stream_type || 'live';
          const mimeType = ch.container_extension || '';

          // Construct metadata
          const meta = {};
          if(ch.plot) meta.plot = ch.plot;
          if(ch.cast) meta.cast = ch.cast;
          if(ch.director) meta.director = ch.director;
          if(ch.genre) meta.genre = ch.genre;
          if(ch.releaseDate) meta.releaseDate = ch.releaseDate;
          if(ch.rating) meta.rating = ch.rating;
          if(ch.rating_5based) meta.rating_5based = ch.rating_5based;
          if(ch.backdrop_path) meta.backdrop_path = ch.backdrop_path;
          if(ch.youtube_trailer) meta.youtube_trailer = ch.youtube_trailer;
          if(ch.episode_run_time) meta.episode_run_time = ch.episode_run_time;
          if(ch.added) meta.added = ch.added;

          const metaStr = JSON.stringify(meta);

          if (existingId) {
            // Update existing channel - preserves ID and user_channels relationships
            updateChannel.run(
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || ch.cover || '',
              ch.epg_channel_id || '',
              i, // original_sort_order
              tvArchive,
              tvArchiveDuration,
              streamType,
              metaStr,
              mimeType,
              providerId,
              sid
            );
            channelsUpdated++;
            provChannelId = existingId;
          } else {
            // Insert new channel
            const info = insertChannel.run(
              providerId,
              sid,
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || ch.cover || '',
              streamType,
              ch.epg_channel_id || '',
              i, // original_sort_order
              tvArchive,
              tvArchiveDuration,
              metaStr,
              mimeType
            );
            channelsAdded++;
            provChannelId = info.lastInsertRowid;
          }
          
          // Auto-add to user categories if enabled
          if (config && config.auto_add_channels) {
            const catId = Number(ch.category_id || 0);
            const catType = ch.category_type || 'live';
            const lookupKey = `${catId}_${catType}`;

            const userCatId = categoryMap.get(lookupKey);
            
            if (userCatId) {
              // Check if already added
              const existingUserChannel = db.prepare('SELECT id FROM user_channels WHERE user_category_id = ? AND provider_channel_id = ?').get(userCatId, provChannelId);
              
              if (!existingUserChannel) {
                const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_channels WHERE user_category_id = ?').get(userCatId);
                const newSortOrder = (maxSort?.max_sort || -1) + 1;
                
                db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)').run(userCatId, provChannelId, newSortOrder);
              }
            }
          }
        }
      }
    })();
    
    // Update sync config
    if (config) {
      const nextSync = calculateNextSync(config.sync_interval);
      db.prepare('UPDATE sync_configs SET last_sync = ?, next_sync = ? WHERE id = ?').run(startTime, nextSync, config.id);
    }
    
    // Log success
    db.prepare(`
      INSERT INTO sync_logs (provider_id, user_id, sync_time, status, channels_added, channels_updated, categories_added)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(providerId, userId, startTime, 'success', channelsAdded, channelsUpdated, categoriesAdded);
    
    console.log(`✅ Sync completed: ${channelsAdded} added, ${channelsUpdated} updated, ${categoriesAdded} categories`);
    
  } catch (e) {
    errorMessage = e.message;
    console.error(`❌ Sync failed:`, e);
    
    // Log error
    db.prepare(`
      INSERT INTO sync_logs (provider_id, user_id, sync_time, status, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(providerId, userId, startTime, 'error', errorMessage);
  }
  
  return { channelsAdded, channelsUpdated, categoriesAdded, errorMessage };
}

function startSyncScheduler() {
  // Clear existing intervals
  syncIntervals.forEach(interval => clearInterval(interval));
  syncIntervals.clear();
  
  // Load all enabled sync configs
  const configs = db.prepare('SELECT * FROM sync_configs WHERE enabled = 1').all();
  
  for (const config of configs) {
    const checkInterval = 60000; // Check every minute
    
    const interval = setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      const currentConfig = db.prepare('SELECT * FROM sync_configs WHERE id = ?').get(config.id);
      
      if (currentConfig && currentConfig.enabled && currentConfig.next_sync <= now) {
        await performSync(currentConfig.provider_id, currentConfig.user_id, false);
      }
    }, checkInterval);
    
    syncIntervals.set(config.id, interval);
    console.log(`📅 Scheduled sync for provider ${config.provider_id} (${config.sync_interval})`);
  }
}

// Start scheduler on startup
startSyncScheduler();
startEpgScheduler();

function startEpgScheduler() {
  const failedUpdates = new Map();

  // Check every minute
  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);

    // 1. Custom Sources
    const sources = db.prepare('SELECT * FROM epg_sources WHERE enabled = 1 AND is_updating = 0').all();
    for (const source of sources) {
      if (source.last_update + source.update_interval <= now) {
        try {
          await updateEpgSource(source.id);
        } catch (e) {
          console.error(`Scheduled EPG update failed for ${source.name}:`, e.message);
        }
      }
    }

    // 2. Provider Sources
    const providers = db.prepare("SELECT * FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != '' AND epg_enabled = 1").all();
    for (const provider of providers) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
      let lastUpdate = 0;
      if (fs.existsSync(cacheFile)) {
        const stats = fs.statSync(cacheFile);
        lastUpdate = Math.floor(stats.mtimeMs / 1000);
      }

      const interval = provider.epg_update_interval || 86400;

      // Check if recently failed (Backoff: 15 minutes)
      const lastFail = failedUpdates.get(provider.id) || 0;
      if (lastFail && (lastFail + 900 > now)) continue;

      if (lastUpdate + interval <= now) {
        try {
          console.log(`🔄 Starting scheduled EPG update for provider ${provider.name}`);
          const response = await fetch(provider.epg_url);
          if (response.ok) {
            const epgData = await response.text();
            await fs.promises.writeFile(cacheFile, epgData, 'utf8');
            console.log(`✅ Scheduled EPG update success: ${provider.name}`);
            failedUpdates.delete(provider.id);
          } else {
            console.error(`Scheduled EPG update HTTP error ${response.status} for ${provider.name}`);
            failedUpdates.set(provider.id, now);
          }
        } catch (e) {
          console.error(`Scheduled EPG update failed for ${provider.name}:`, e.message);
          failedUpdates.set(provider.id, now);
        }
      }
    }
  }, 60000);
  console.log('📅 EPG Scheduler started');
}

function getSetting(key, defaultValue) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

function startCleanupScheduler() {
  setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000);
      // Clean old client logs (7 days)
      const retention = 7 * 86400;
      db.prepare('DELETE FROM client_logs WHERE timestamp < ?').run(now - retention);
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }, 3600000); // Every hour
}
startCleanupScheduler();

// Adult Content Detection
function isAdultCategory(name) {
  const adultKeywords = [
    '18+', 'adult', 'xxx', 'porn', 'erotic', 'sex', 'nsfw',
    'for adults', 'erwachsene', '+18', '18 plus', 'mature',
    'xxx', 'sexy', 'hot'
  ];
  const nameLower = name.toLowerCase();
  return adultKeywords.some(kw => nameLower.includes(kw));
}

// Xtream Client
function createXtreamClient(provider) {
  let baseUrl = (provider.url || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
  baseUrl = baseUrl.replace(/\/+$/, '');
  return new Xtream({ url: baseUrl, username: provider.username, password: provider.password });
}

// Auth
// JWT Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Generate JWT token
function generateToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username,
      is_active: user.is_active 
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Create default admin user on first start
async function createDefaultAdmin() {
  try {
    const adminCount = db.prepare('SELECT COUNT(*) as count FROM admin_users').get();
    
    if (adminCount.count === 0) {
      // Use env password or generate random
      const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
      let passwordToUse;

      if (initialPassword) {
        passwordToUse = initialPassword;
      } else {
        const crypto = await import('crypto');
        passwordToUse = crypto.randomBytes(8).toString('hex');
      }

      const username = 'admin';
      
      // Hash password
      const hashedPassword = await bcrypt.hash(passwordToUse, BCRYPT_ROUNDS);
      
      // Create admin user in admin_users table (NOT in users table)
      db.prepare('INSERT INTO admin_users (username, password, is_active) VALUES (?, ?, 1)')
        .run(username, hashedPassword);
      
      console.log('\\n' + '='.repeat(60));
      console.log('🔐 DEFAULT ADMIN USER CREATED (WebGUI Only)');
      console.log('='.repeat(60));
      console.log(`Username: ${username}`);
      console.log(`Password: ${passwordToUse}`);
      console.log('='.repeat(60));
      console.log('⚠️  IMPORTANT: Please change this password after first login!');
      console.log('ℹ️  NOTE: Admin user is for WebGUI only, not for IPTV streams!');
      console.log('='.repeat(60) + '\\n');
    }
  } catch (error) {
    console.error('❌ Error creating default admin:', error);
  }
}

// Authenticate user with bcrypt
async function authUser(username, password) {
  try {
    const u = (username || '').trim();
    const p = (password || '').trim();
    if (!u || !p) return null;
    
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(u);
    if (!user) return null;
    
    // Compare password
    let isValid = false;
    if (user.password && user.password.startsWith('$2b$')) {
        isValid = await bcrypt.compare(p, user.password);
    } else {
        const decrypted = decrypt(user.password);
        isValid = (decrypted === p);
    }

    return isValid ? user : null;
  } catch (e) {
    console.error('authUser error:', e);
    return null;
  }
}

// Helper for Xtream endpoints
async function getXtreamUser(req) {
  const username = (req.params.username || req.query.username || '').trim();
  const password = (req.params.password || req.query.password || '').trim();
  const token = (req.query.token || '').trim();

  let user = null;

  if (token) {
    const now = Math.floor(Date.now() / 1000);
    const valid = db.prepare('SELECT user_id FROM temporary_tokens WHERE token = ? AND expires_at > ?').get(token, now);
    if (valid) {
      user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(valid.user_id);
    }
  }

  if (!user) {
    user = await authUser(username, password);
  }

  if (!user && username && !token) {
    const ip = req.ip;
    const now = Math.floor(Date.now() / 1000);

    // Log Failure
    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'xtream_login_failed', `User: ${username}`, now);

    // Check for brute force
    const failWindow = now - 900; // 15 minutes
    const failCount = db.prepare(`
      SELECT COUNT(*) as count FROM security_logs
      WHERE ip = ? AND action IN ('login_failed', 'xtream_login_failed') AND timestamp > ?
    `).get(ip, failWindow).count;

    const threshold = parseInt(getSetting('iptv_block_threshold', '10')) || 10;
    if (failCount >= threshold) {
      // Check whitelist before blocking
      const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);

      if (!whitelisted) {
        const durationSetting = getSetting('iptv_block_duration', '3600');
        const blockDuration = parseInt(durationSetting) || 3600;
        const expiresAt = now + blockDuration;
        db.prepare(`
          INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET expires_at = excluded.expires_at
        `).run(ip, 'Too many failed Xtream login attempts', expiresAt);

        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_blocked', `Too many failed Xtream logins (Threshold: ${threshold})`, now);
        console.warn(`⛔ Blocking IP ${ip} due to ${failCount} failed Xtream logins`);
      }
    }
  }

  return user;
}

// === API: Player Token ===
app.post('/api/player/token', authenticateToken, (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({error: 'user_id required'});

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
    if (!user) return res.status(404).json({error: 'User not found'});

    const token = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 21600; // 6 hours

    db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, user_id, expiresAt);

    // Cleanup old tokens
    db.prepare('DELETE FROM temporary_tokens WHERE expires_at < ?').run(now);

    res.json({token});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === API: Users ===
app.get('/api/users', authenticateToken, (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, password, is_active FROM users ORDER BY id').all();
    const result = users.map(u => {
        let plain = null;
        if (u.password && !u.password.startsWith('$2b$')) {
            plain = decrypt(u.password);
        }
        return {
            id: u.id,
            username: u.username,
            is_active: u.is_active,
            plain_password: plain
        };
    });
    res.json(result);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/users', authLimiter, authenticateToken, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validation
    if (!username || !password) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Username and password are required'
      });
    }
    
    const u = username.trim();
    const p = password.trim();
    
    // Validate username
    if (u.length < 3 || u.length > 50) {
      return res.status(400).json({
        error: 'invalid_username_length',
        message: 'Username must be 3-50 characters'
      });
    }
    
    if (!/^[a-zA-Z0-9_]+$/.test(u)) {
      return res.status(400).json({
        error: 'invalid_username_format',
        message: 'Username can only contain letters, numbers, and underscores'
      });
    }
    
    // Validate password
    if (p.length < 8) {
      return res.status(400).json({
        error: 'password_too_short',
        message: 'Password must be at least 8 characters'
      });
    }
    
    // Encrypt password (reversible)
    const encryptedPassword = encrypt(p);
    
    // Insert user
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(u, encryptedPassword);
    
    res.json({
      id: info.lastInsertRowid,
      message: 'User created successfully'
    });
  } catch (e) { 
    res.status(400).json({error: e.message}); 
  }
});

app.put('/api/users/:id', authLimiter, authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { username, password } = req.body;

    // Get existing user
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({error: 'user not found'});

    const updates = [];
    const params = [];

    if (username) {
        const u = username.trim();
        if (u.length < 3 || u.length > 50) {
            return res.status(400).json({ error: 'invalid_username_length' });
        }
        // Check uniqueness if username changed
        if (u !== existing.username) {
           const duplicate = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
           if (duplicate) return res.status(400).json({ error: 'username_taken' });
        }
        updates.push('username = ?');
        params.push(u);
    }

    if (password) {
        const p = password.trim();
        if (p.length < 8) {
            return res.status(400).json({ error: 'password_too_short' });
        }
        const encryptedPassword = encrypt(p);
        updates.push('password = ?');
        params.push(encryptedPassword);
    }

    if (updates.length === 0) return res.json({success: true}); // Nothing to update

    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === API: Authentication ===
app.post('/api/login', authLimiter, async (req, res) => {
  const ip = req.ip;
  const now = Math.floor(Date.now() / 1000);

  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({error: 'missing_credentials'});
    }
    
    // Check admin_users table for WebGUI login
    const admin = db.prepare('SELECT * FROM admin_users WHERE username = ? AND is_active = 1').get(username);
    
    if (admin) {
      const isValid = await bcrypt.compare(password, admin.password);
      if (isValid) {
        const token = generateToken(admin);

        // Log Success
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'login_success', `User: ${username}`, now);

        return res.json({
          token,
          user: {
            id: admin.id,
            username: admin.username,
            is_active: admin.is_active,
            is_admin: true
          },
          expiresIn: JWT_EXPIRES_IN
        });
      }
    }
    
    // Log Failure
    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'login_failed', `User: ${username}`, now);

    // Check for brute force
    const failWindow = now - 900; // 15 minutes
    const failCount = db.prepare(`
      SELECT COUNT(*) as count FROM security_logs
      WHERE ip = ? AND action IN ('login_failed', 'xtream_login_failed') AND timestamp > ?
    `).get(ip, failWindow).count;

    const threshold = parseInt(getSetting('admin_block_threshold', '5')) || 5;
    if (failCount >= threshold) {
      // Check whitelist before blocking
      const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);

      if (!whitelisted) {
        const durationSetting = getSetting('admin_block_duration', '3600');
        const blockDuration = parseInt(durationSetting) || 3600;
        const expiresAt = now + blockDuration;
        db.prepare(`
          INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET expires_at = excluded.expires_at
        `).run(ip, 'Too many failed login attempts', expiresAt);

        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_blocked', `Too many failed WebUI logins (Threshold: ${threshold})`, now);
        console.warn(`⛔ Blocking IP ${ip} due to ${failCount} failed logins`);
      }
    }

    return res.status(401).json({error: 'invalid_credentials'});
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({error: 'server_error'});
  }
});

// Verify token endpoint
app.get('/api/verify-token', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: req.user
  });
});

// Change password endpoint
app.post('/api/change-password', authenticateToken, authLimiter, async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user.id;
    
    // Validation
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({error: 'missing_fields'});
    }
    
    if (newPassword !== confirmPassword) {
      return res.status(400).json({error: 'passwords_dont_match'});
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({error: 'password_too_short'});
    }
    
    // Get admin user
    const admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(userId);
    if (!admin) {
      return res.status(404).json({error: 'user_not_found'});
    }
    
    // Verify old password
    const isValidOldPassword = await bcrypt.compare(oldPassword, admin.password);
    if (!isValidOldPassword) {
      return res.status(401).json({error: 'invalid_old_password'});
    }
    
    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    
    // Update password
    db.prepare('UPDATE admin_users SET password = ? WHERE id = ?').run(hashedNewPassword, userId);
    
    console.log(`✅ Password changed for admin: ${admin.username}`);
    
    res.json({
      success: true,
      message: 'password_changed_successfully'
    });
  } catch (e) {
    console.error('Change password error:', e);
    res.status(500).json({error: 'server_error'});
  }
});

// === API: Providers ===
app.get('/api/providers', authenticateToken, (req, res) => {
  try {
    const { user_id } = req.query;
    let query = `
      SELECT p.*, u.username as owner_name
      FROM providers p
      LEFT JOIN users u ON u.id = p.user_id
    `;
    const params = [];

    if (user_id) {
      query += ' WHERE p.user_id = ?';
      params.push(Number(user_id));
    }

    const providers = db.prepare(query).all(...params);
    // Mask passwords and add EPG info
    const safeProviders = providers.map(p => {
      let lastUpdate = 0;
      if (p.epg_url) {
         const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${p.id}.xml`);
         if (fs.existsSync(cacheFile)) {
             try {
                lastUpdate = Math.floor(fs.statSync(cacheFile).mtimeMs / 1000);
             } catch(e) {}
         }
      }
      return {
        ...p,
        password: '********', // Masked
        epg_last_updated: lastUpdate
      };
    });
    res.json(safeProviders);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/providers', authenticateToken, async (req, res) => {
  try {
    const { name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled } = req.body;
    if (!name || !url || !username || !password) return res.status(400).json({error: 'missing'});

    // Validate URL
    if (!/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URL must start with http:// or https://'});
    }

    let finalEpgUrl = (epg_url || '').trim();
    if (finalEpgUrl && !/^https?:\/\//i.test(finalEpgUrl)) {
      return res.status(400).json({error: 'invalid_epg_url', message: 'EPG URL must start with http:// or https://'});
    }

    // Auto-discover EPG URL if missing
    if (!finalEpgUrl) {
      try {
        const baseUrl = url.trim().replace(/\/+$/, '');
        const discoveredUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(username.trim())}&password=${encodeURIComponent(password.trim())}`;
        // Check if it exists (HEAD request with short timeout)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(discoveredUrl, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          finalEpgUrl = discoveredUrl;
          console.log('✅ Auto-discovered EPG URL:', finalEpgUrl);
        }
      } catch (e) {
        console.log('⚠️ EPG Auto-discovery failed:', e.message);
      }
    }

    const encryptedPassword = encrypt(password.trim());

    const info = db.prepare(`
      INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      url.trim(),
      username.trim(),
      encryptedPassword,
      finalEpgUrl,
      user_id ? Number(user_id) : null,
      epg_update_interval ? Number(epg_update_interval) : 86400,
      epg_enabled !== undefined ? (epg_enabled ? 1 : 0) : 1
    );
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/providers/:id/sync', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({error: 'user_id required'});
    }
    
    const result = await performSync(id, user_id, true);
    
    if (result.errorMessage) {
      return res.status(500).json({error: result.errorMessage});
    }
    
    res.json({
      success: true,
      channels_added: result.channelsAdded,
      channels_updated: result.channelsUpdated,
      categories_added: result.categoriesAdded
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

app.get('/api/providers/:id/channels', authenticateToken, (req, res) => {
  try {
    const { type, page, limit, search } = req.query;
    const providerId = Number(req.params.id);

    // Pagination Logic
    if (page || limit || search) {
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 50;
      const offset = (pageNum - 1) * limitNum;
      const searchTerm = (search || '').trim().toLowerCase();

      let baseQuery = 'FROM provider_channels WHERE provider_id = ?';
      const params = [providerId];

      if (type) {
        baseQuery += ' AND stream_type = ?';
        params.push(type);
      }

      if (searchTerm) {
        baseQuery += ' AND lower(name) LIKE ?';
        params.push(`%${searchTerm}%`);
      }

      // Get Total Count
      const countQuery = `SELECT COUNT(*) as count ${baseQuery}`;
      const total = db.prepare(countQuery).get(...params).count;

      // Get Data
      const dataQuery = `SELECT * ${baseQuery} ORDER BY original_sort_order ASC, name ASC LIMIT ? OFFSET ?`;
      const rows = db.prepare(dataQuery).all(...params, limitNum, offset);

      return res.json({
        channels: rows,
        total: total,
        page: pageNum,
        limit: limitNum
      });
    }

    // Legacy Behavior (Fetch All)
    let query = 'SELECT * FROM provider_channels WHERE provider_id = ?';
    const params = [providerId];

    if (type) {
        query += ' AND stream_type = ?';
        params.push(type);
    }

    query += ' ORDER BY original_sort_order ASC, name ASC';

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Provider-Kategorien abrufen
app.get('/api/providers/:id/categories', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = req.query.type || 'live'; // 'live', 'movie', 'series'

    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!provider) return res.status(404).json({error: 'Provider not found'});

    // Decrypt password
    provider.password = decrypt(provider.password);

    let categories = [];
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}`;
    let action = 'get_live_categories';

    if(type === 'movie') action = 'get_vod_categories';
    if(type === 'series') action = 'get_series_categories';
    
    try {
      const apiUrl = `${baseUrl}/player_api.php?${authParams}&action=${action}`;
      const resp = await fetch(apiUrl);
      if (resp.ok) {
        categories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }

    // Note: We need to filter local counts by stream_type to match the requested category type
    // This is an approximation since original_category_id isn't unique across types usually.
    // However, provider_channels now has stream_type.
    let streamType = 'live';
    if(type === 'movie') streamType = 'movie';
    if(type === 'series') streamType = 'series';

    const localCats = db.prepare(`
      SELECT DISTINCT original_category_id, 
             COUNT(*) as channel_count
      FROM provider_channels 
      WHERE provider_id = ? AND stream_type = ? AND original_category_id > 0
      GROUP BY original_category_id
      ORDER BY channel_count DESC
    `).all(id, streamType);

    const localCatsMap = new Map();
    for (const l of localCats) {
      localCatsMap.set(Number(l.original_category_id), l);
    }

    const merged = categories.map(cat => {
      const local = localCatsMap.get(Number(cat.category_id));
      const isAdult = isAdultCategory(cat.category_name);
      
      return {
        category_id: cat.category_id,
        category_name: cat.category_name,
        channel_count: local ? local.channel_count : 0,
        is_adult: isAdult,
        category_type: type
      };
    });

    res.json(merged);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// Provider-Kategorie importieren
app.post('/api/providers/:providerId/import-category', authenticateToken, async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, category_id, category_name, import_channels, type } = req.body;
    const catType = type || 'live';
    
    if (!user_id || !category_id || !category_name) {
      return res.status(400).json({error: 'Missing required fields'});
    }

    const isAdult = isAdultCategory(category_name) ? 1 : 0;

    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(user_id);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const catInfo = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)').run(user_id, category_name, isAdult, newSortOrder, catType);
    const newCategoryId = catInfo.lastInsertRowid;

    // Update or Create Mapping
    db.prepare(`
      INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(provider_id, user_id, provider_category_id, category_type)
      DO UPDATE SET user_category_id = excluded.user_category_id
    `).run(providerId, user_id, Number(category_id), category_name, newCategoryId, catType);

    if (import_channels) {
      let streamType = 'live';
      if(catType === 'movie') streamType = 'movie';
      if(catType === 'series') streamType = 'series';

      // Use original_sort_order for correct import order
      const channels = db.prepare(`
        SELECT id FROM provider_channels 
        WHERE provider_id = ? AND original_category_id = ? AND stream_type = ?
        ORDER BY original_sort_order ASC, name ASC
      `).all(providerId, Number(category_id), streamType);

      const insertChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');
      
      db.transaction(() => {
        channels.forEach((ch, idx) => {
          insertChannel.run(newCategoryId, ch.id, idx);
        });
      })();

      res.json({
        success: true, 
        category_id: newCategoryId,
        channels_imported: channels.length,
        is_adult: isAdult
      });
    } else {
      res.json({
        success: true, 
        category_id: newCategoryId,
        channels_imported: 0,
        is_adult: isAdult
      });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// Import multiple categories
app.post('/api/providers/:providerId/import-categories', authenticateToken, async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, categories } = req.body;

    if (!user_id || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({error: 'Missing required fields or invalid categories'});
    }

    const results = [];
    let totalChannels = 0;
    let totalCategories = 0;

    const insertUserCategory = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)');
    const insertChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');
    const getMaxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?');

    db.transaction(() => {
      let maxSort = getMaxSort.get(user_id).max_sort;

      for (const cat of categories) {
        if (!cat.id || !cat.name) continue;

        const catType = cat.type || 'live';
        const isAdult = isAdultCategory(cat.name) ? 1 : 0;
        maxSort++;

        const catInfo = insertUserCategory.run(user_id, cat.name, isAdult, maxSort, catType);
        const newCategoryId = catInfo.lastInsertRowid;
        totalCategories++;

        // Update or Create Mapping
        db.prepare(`
          INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
          VALUES (?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(provider_id, user_id, provider_category_id, category_type)
          DO UPDATE SET user_category_id = excluded.user_category_id
        `).run(providerId, user_id, Number(cat.id), cat.name, newCategoryId, catType);

        let channelsImported = 0;
        if (cat.import_channels) {
          let streamType = 'live';
          if(catType === 'movie') streamType = 'movie';
          if(catType === 'series') streamType = 'series';

          const channels = db.prepare(`
            SELECT id FROM provider_channels
            WHERE provider_id = ? AND original_category_id = ? AND stream_type = ?
            ORDER BY original_sort_order ASC, name ASC
          `).all(providerId, Number(cat.id), streamType);

          channels.forEach((ch, idx) => {
            insertChannel.run(newCategoryId, ch.id, idx);
          });
          channelsImported = channels.length;
          totalChannels += channelsImported;
        }

        results.push({
          category_id: cat.id,
          new_id: newCategoryId,
          name: cat.name,
          channels_imported: channelsImported
        });
      }
    })();

    res.json({
      success: true,
      categories_imported: totalCategories,
      channels_imported: totalChannels,
      results
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// === API: User Categories ===
app.get('/api/users/:userId/categories', authenticateToken, (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order').all(Number(req.params.userId)));
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/users/:userId/categories', authenticateToken, (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});
    
    const userId = Number(req.params.userId);
    const isAdult = isAdultCategory(name) ? 1 : 0;
    const catType = type || 'live';
    
    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;
    
    const info = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)').run(userId, name.trim(), isAdult, newSortOrder, catType);
    res.json({id: info.lastInsertRowid, is_adult: isAdult, type: catType});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Kategorien neu sortieren
app.put('/api/users/:userId/categories/reorder', authenticateToken, (req, res) => {
  try {
    const { category_ids } = req.body; // Array von IDs in neuer Reihenfolge
    if (!Array.isArray(category_ids)) return res.status(400).json({error: 'category_ids must be array'});
    
    const update = db.prepare('UPDATE user_categories SET sort_order = ? WHERE id = ?');
    
    db.transaction(() => {
      category_ids.forEach((catId, index) => {
        update.run(index, catId);
      });
    })();
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.get('/api/user-categories/:catId/channels', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT uc.id as user_channel_id, pc.*
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      WHERE uc.user_category_id = ?
      ORDER BY uc.sort_order
    `).all(Number(req.params.catId));
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/user-categories/:catId/channels', authenticateToken, (req, res) => {
  try {
    const catId = Number(req.params.catId);
    const { provider_channel_id } = req.body;
    if (!provider_channel_id) return res.status(400).json({error: 'channel required'});
    
    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_channels WHERE user_category_id = ?').get(catId);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;
    
    const info = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)').run(catId, Number(provider_channel_id), newSortOrder);
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Kanäle neu sortieren
app.put('/api/user-categories/:catId/channels/reorder', authenticateToken, (req, res) => {
  try {
    const { channel_ids } = req.body; // Array von user_channel IDs in neuer Reihenfolge
    if (!Array.isArray(channel_ids)) return res.status(400).json({error: 'channel_ids must be array'});
    
    const update = db.prepare('UPDATE user_channels SET sort_order = ? WHERE id = ?');
    
    db.transaction(() => {
      channel_ids.forEach((chId, index) => {
        update.run(index, chId);
      });
    })();
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === Xtream API ===
app.get('/player_api.php', async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const action = (req.query.action || '').trim();
    
    const user = await getXtreamUser(req);
    if (!user) {
      return res.json({user_info: {auth: 0, message: 'Invalid credentials'}});
    }

    const now = Math.floor(Date.now() / 1000);
    
    if (!action || action === '') {
      return res.json({
        user_info: {
          username: username,
          password: password,
          message: '',
          auth: 1,
          status: 'Active',
          exp_date: '1773864593',
          is_trial: '0',
          active_cons: '0',
          created_at: now.toString(),
          max_connections: '1',
          allowed_output_formats: ['m3u8', 'ts']
        },
        server_info: {
          url: req.hostname,
          port: '3000',
          https_port: '',
          server_protocol: 'http',
          rtmp_port: '',
          timezone: 'Europe/Berlin',
          timestamp_now: now,
          time_now: new Date(now * 1000).toISOString().slice(0, 19).replace('T', ' '),
          process: true
        }
      });
    }

    // Helper to get categories containing specific stream type
    const getUserCategoriesByType = (type) => {
      // Optimization: If we just return all categories, it works, but better to filter
      // returning categories that have at least one channel of that type
      const cats = db.prepare(`
        SELECT DISTINCT cat.*
        FROM user_categories cat
        JOIN user_channels uc ON uc.user_category_id = cat.id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = ?
        ORDER BY cat.sort_order
      `).all(user.id, type);

      return cats.map(c => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }));
    };

    if (action === 'get_live_categories') {
      return res.json(getUserCategoriesByType('live'));
    }

    if (action === 'get_vod_categories') {
      return res.json(getUserCategoriesByType('movie'));
    }

    if (action === 'get_series_categories') {
      return res.json(getUserCategoriesByType('series'));
    }

    if (action === 'get_live_streams') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.*, cat.is_adult as category_is_adult,
               map.epg_channel_id as manual_epg_id
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE cat.user_id = ? AND pc.stream_type = 'live'
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = rows.map((ch, i) => {
        let iconUrl = ch.logo || '';
        return {
          num: i + 1,
          name: ch.name,
          stream_type: 'live',
          stream_id: Number(ch.user_channel_id),
          stream_icon: iconUrl,
          epg_channel_id: ch.manual_epg_id || ch.epg_channel_id || '',
          added: now.toString(),
          is_adult: ch.category_is_adult || 0,
          category_id: String(ch.user_category_id),
          category_ids: [Number(ch.user_category_id)],
          custom_sid: null,
          tv_archive: ch.tv_archive || 0,
          direct_source: '',
          tv_archive_duration: ch.tv_archive_duration || 0
        };
      });
      return res.json(result);
    }

    if (action === 'get_vod_streams') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.*, cat.is_adult as category_is_adult
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ? AND pc.stream_type = 'movie'
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = rows.map((ch, i) => {
        let meta = {};
        try { meta = JSON.parse(ch.metadata || '{}'); } catch(e){}

        return {
          num: i + 1,
          name: ch.name,
          stream_type: 'movie',
          stream_id: Number(ch.user_channel_id),
          stream_icon: ch.logo || '',
          rating: meta.rating || '',
          rating_5based: meta.rating_5based || 0,
          added: meta.added || now.toString(),
          category_id: String(ch.user_category_id),
          container_extension: ch.mime_type || 'mp4',
          custom_sid: null,
          direct_source: ''
        };
      });
      return res.json(result);
    }

    if (action === 'get_series') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.*, cat.is_adult as category_is_adult
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ? AND pc.stream_type = 'series'
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = rows.map((ch, i) => {
        let meta = {};
        try { meta = JSON.parse(ch.metadata || '{}'); } catch(e){}

        return {
          num: i + 1,
          name: ch.name,
          series_id: Number(ch.user_channel_id),
          cover: ch.logo || '',
          plot: meta.plot || '',
          cast: meta.cast || '',
          director: meta.director || '',
          genre: meta.genre || '',
          releaseDate: meta.releaseDate || '',
          last_modified: meta.added || now.toString(),
          rating: meta.rating || '',
          rating_5based: meta.rating_5based || 0,
          backdrop_path: meta.backdrop_path || [],
          youtube_trailer: meta.youtube_trailer || '',
          episode_run_time: meta.episode_run_time || '',
          category_id: String(ch.user_category_id)
        };
      });
      return res.json(result);
    }

    if (action === 'get_series_info') {
      const seriesId = Number(req.query.series_id);
      if (!seriesId) return res.json({});

      // 1. Get local series info
      const channel = db.prepare(`
        SELECT uc.id as user_channel_id, pc.*, p.url, p.username, p.password
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE uc.id = ? AND cat.user_id = ?
      `).get(seriesId, user.id);

      if (!channel) return res.json({});

      // 2. Fetch remote info
      const provPass = decrypt(channel.password);
      const baseUrl = channel.url.replace(/\/+$/, '');
      const remoteSeriesId = channel.remote_stream_id;

      try {
        const resp = await fetch(`${baseUrl}/player_api.php?username=${encodeURIComponent(channel.username)}&password=${encodeURIComponent(provPass)}&action=get_series_info&series_id=${remoteSeriesId}`);
        if (!resp.ok) return res.json({});

        const data = await resp.json();

        // 3. Rewrite Episode IDs
        const OFFSET = 1000000000;
        const providerId = channel.provider_id;

        if (data.episodes) {
           for (const seasonKey in data.episodes) {
              const episodes = data.episodes[seasonKey];
              if (Array.isArray(episodes)) {
                 episodes.forEach(ep => {
                    const originalId = Number(ep.id);
                    // Encode: providerId * OFFSET + originalId
                    ep.id = (providerId * OFFSET + originalId).toString();
                 });
              }
           }
        }

        return res.json(data);

      } catch(e) {
         console.error('get_series_info error:', e);
         return res.json({});
      }
    }

    res.status(400).json([]);
  } catch (e) {
    console.error('player_api error:', e);
    res.status(500).json([]);
  }
});

// === Local User Playlist Generator ===
app.get('/api/player/playlist', async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.status(401).send('Unauthorized');

    // Fetch user's channels from local DB
    const channels = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.name,
        pc.logo,
        pc.remote_stream_id,
        pc.stream_type,
        pc.mime_type,
        cat.name as category_name,
        p.url as provider_url,
        p.username as provider_user,
        p.password as provider_password
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      JOIN providers p ON p.id = pc.provider_id
      WHERE cat.user_id = ? AND pc.stream_type != 'series'
      ORDER BY uc.sort_order
    `).all(user.id);

    let playlist = '#EXTM3U\n';
    const host = `${req.protocol}://${req.get('host')}`;
    const tokenParam = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';

    for (const ch of channels) {
      const group = ch.category_name || 'Uncategorized';
      const logo = ch.logo || '';
      const name = ch.name || 'Unknown';

      // Determine extension and path based on stream type
      let ext = 'ts';
      let typePath = 'live';

      if (ch.stream_type === 'movie') {
         typePath = 'movie';
         ext = ch.mime_type || 'mp4';
      } else if (ch.stream_type === 'series') {
         typePath = 'series'; // Note: Series usually need episode lookup, but if mapping 1:1 user_channel to stream, we use /series/ endpoint logic
         ext = ch.mime_type || 'mp4';
      } else {
         // Live
         // Default to TS for better compatibility with mpegts.js and to bypass flaky HLS upstream
         ext = 'ts';
      }

      // Construct SECURE local proxy URL
      // We use dummy user/pass 'token/auth' because we rely on the token param or headers
      // The stream_id here is the USER channel ID (uc.id), which the proxy resolves to provider credentials
      const streamUrl = `${host}/${typePath}/token/auth/${ch.user_channel_id}.${ext}${tokenParam}`;

      // Escape metadata for M3U
      const safeGroup = group.replace(/"/g, '');
      const safeLogo = logo.replace(/"/g, '');
      const safeName = name.replace(/,/g, ' ');

      playlist += `#EXTINF:-1 tvg-name="${safeName}" tvg-logo="${safeLogo}" group-title="${safeGroup}",${name}\n`;
      playlist += `${streamUrl}\n`;
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(playlist);

  } catch (e) {
    console.error('Playlist generation error:', e);
    res.status(500).send('#EXTM3U\n');
  }
});

// === M3U Playlist API ===
app.get('/get.php', async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const type = (req.query.type || 'm3u').trim();
    const output = (req.query.output || 'ts').trim();

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const rows = db.prepare(`
      SELECT uc.id as user_channel_id, pc.name, pc.logo, pc.epg_channel_id,
             cat.name as category_name, map.epg_channel_id as manual_epg_id
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE cat.user_id = ?
      ORDER BY uc.sort_order
    `).all(user.id);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    let m3u = '#EXTM3U';

    if (type === 'm3u_plus') {
       m3u += ` url-tvg="${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}"\n`;
    } else {
       m3u += '\n';
    }

    for (const ch of rows) {
      const epgId = ch.manual_epg_id || ch.epg_channel_id || '';
      const logo = ch.logo || '';
      const group = ch.category_name || '';
      const name = ch.name || 'Unknown';
      const streamId = ch.user_channel_id;

      // Stream URL extension
      const ext = output === 'hls' ? 'm3u8' : 'ts';
      const streamUrl = `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`;

      if (type === 'm3u_plus') {
        m3u += `#EXTINF:-1 tvg-id="${epgId}" tvg-name="${name}" tvg-logo="${logo}" group-title="${group}",${name}\n`;
      } else {
        m3u += `#EXTINF:-1,${name}\n`;
      }
      m3u += `${streamUrl}\n`;
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl'); // Standard M3U MIME
    res.setHeader('Content-Disposition', `attachment; filename="playlist.m3u"`);
    res.send(m3u);

  } catch (e) {
    console.error('get.php error:', e);
    res.sendStatus(500);
  }
});

// Picon caching function
// Picon caching removed - using direct URLs for better performance and reliability
// This avoids timeout issues and reduces server load
async function cachePicon(originalUrl, channelName) {
  // Simply return the original URL - no caching needed
  return originalUrl || null;
}

// === Stream Proxy ===
app.get(['/live/:username/:password/:stream_id.ts', '/live/:username/:password/:stream_id.m3u8'], async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const streamId = Number(req.params.stream_id || 0);
    
    if (!streamId) return res.sendStatus(404);
    
    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.id as provider_channel_id,
        pc.remote_stream_id,
        pc.name,
        p.url as provider_url,
        p.username as provider_user,
        p.password as provider_pass
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE uc.id = ? AND cat.user_id = ?
    `).get(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    // Cleanup existing streams for this user/ip (Fast-Tapping Fix)
    for (const [key, stream] of activeStreams.entries()) {
      if (stream.user_id === user.id && stream.ip === req.ip) {
         activeStreams.delete(key);
      }
    }

    // Track active stream
    const startTime = Date.now();
    activeStreams.set(connectionId, {
      id: connectionId,
      user_id: user.id,
      username: user.username,
      channel_name: channel.name,
      start_time: startTime,
      ip: req.ip
    });

    // Update statistics in DB
    const now = Math.floor(startTime / 1000);
    const existingStat = db.prepare('SELECT id FROM stream_stats WHERE channel_id = ?').get(channel.provider_channel_id);
    if (existingStat) {
      db.prepare('UPDATE stream_stats SET views = views + 1, last_viewed = ? WHERE id = ?').run(now, existingStat.id);
    } else {
      db.prepare('INSERT INTO stream_stats (channel_id, views, last_viewed) VALUES (?, 1, ?)').run(channel.provider_channel_id, now);
    }

    // Decrypt provider password
    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    const ext = req.path.endsWith('.m3u8') ? 'm3u8' : 'ts';
    const remoteUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;
    
    // Handle Transcoding if requested (only for .ts)
    if (ext === 'ts' && req.query.transcode === 'true') {
      console.log(`🎬 Starting transcoding for stream ${streamId}`);

      // Headers for MPEG-TS
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Connection', 'keep-alive');

      const command = ffmpeg(remoteUrl)
        .inputOptions([
          '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          '-re' // Read input at native frame rate
        ])
        .outputOptions([
          '-c:v copy', // Copy video stream (fast)
          '-c:a aac',  // Transcode audio to AAC
          '-f mpegts'  // Output format
        ])
        .on('error', (err) => {
          if (err.message && !err.message.includes('Output stream closed')) {
             console.error('FFmpeg error:', err.message);
          }
          activeStreams.delete(connectionId);
        })
        .on('end', () => {
          console.log('FFmpeg stream ended');
          activeStreams.delete(connectionId);
        });

      command.pipe(res, { end: true });

      req.on('close', () => {
        command.kill('SIGKILL');
        activeStreams.delete(connectionId);
      });

      return;
    }

    // Fetch with optimized settings for streaming
    const upstream = await fetch(remoteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Connection': 'keep-alive'
      },
      // Don't follow redirects automatically for better control
      redirect: 'follow'
      // No timeout - streams can run indefinitely
    });
    
    if (!upstream.ok || !upstream.body) {
      console.error(`Stream proxy error: ${upstream.status} ${upstream.statusText} for ${remoteUrl}`);
      activeStreams.delete(connectionId);
      return res.sendStatus(502);
    }

    // Handle M3U8 Playlists (Rewrite URLs)
    if (ext === 'm3u8') {
      const text = await upstream.text();
      const baseUrl = remoteUrl;
      const tokenParam = req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';

      const newText = text.replace(/^(?!#)(.+)$/gm, (match) => {
        const line = match.trim();
        if (!line) return match;
        try {
          const absoluteUrl = new URL(line, baseUrl).toString();
          const encoded = encodeURIComponent(absoluteUrl);
          return `/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.ts?url=${encoded}${tokenParam}`;
        } catch (e) {
          return match;
        }
      }).replace(/URI="([^"]+)"/g, (match, p1) => {
        try {
          const absoluteUrl = new URL(p1, baseUrl).toString();
          const encoded = encodeURIComponent(absoluteUrl);
          return `URI="/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.key?url=${encoded}${tokenParam}"`;
        } catch (e) {
          return match;
        }
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(newText);

      activeStreams.delete(connectionId);
      return;
    }

    // Set optimal headers for streaming
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Copy content-length if available
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    
    // Stream the response with error handling
    upstream.body.pipe(res);
    
    // Handle stream errors (only log real errors, not normal disconnects)
    upstream.body.on('error', (err) => {
      // Only log if it's not a normal client disconnect
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.type !== 'aborted') {
        console.error('Stream error:', err.message);
      }
      activeStreams.delete(connectionId);
      if (!res.headersSent) {
        res.sendStatus(502);
      }
    });
    
    // Handle client disconnect gracefully
    req.on('close', () => {
      activeStreams.delete(connectionId);
      if (upstream.body && !upstream.body.destroyed) {
        upstream.body.destroy();
      }
    });
    
  } catch (e) {
    console.error('Stream proxy error:', e.message);
    activeStreams.delete(connectionId);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
});

// === HLS Segment Proxy ===
app.get(['/live/segment/:username/:password/seg.ts', '/live/segment/:username/:password/seg.key'], async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const targetUrl = req.query.url;
    if (!targetUrl) return res.sendStatus(400);

    // Validate URL
    try {
      const parsed = new URL(targetUrl);
      if (!parsed.protocol.startsWith('http')) throw new Error('Invalid protocol');
    } catch (e) {
      return res.sendStatus(400);
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Connection': 'keep-alive'
      },
      redirect: 'follow'
    });

    if (!upstream.ok) {
       // Forward status
       return res.sendStatus(upstream.status);
    }

    // Forward headers
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);
  } catch (e) {
    console.error('Segment proxy error:', e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// === Movie Proxy ===
app.get('/movie/:username/:password/:stream_id.:ext', async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const streamId = Number(req.params.stream_id || 0);
    const ext = req.params.ext;

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.id as provider_channel_id,
        pc.remote_stream_id,
        pc.name,
        p.url as provider_url,
        p.username as provider_user,
        p.password as provider_pass
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE uc.id = ? AND cat.user_id = ?
    `).get(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    // Track active stream
    const startTime = Date.now();
    activeStreams.set(connectionId, {
      id: connectionId,
      user_id: user.id,
      username: user.username,
      channel_name: `${channel.name} (VOD)`,
      start_time: startTime,
      ip: req.ip
    });

    // Update statistics in DB
    const now = Math.floor(startTime / 1000);
    const existingStat = db.prepare('SELECT id FROM stream_stats WHERE channel_id = ?').get(channel.provider_channel_id);
    if (existingStat) {
      db.prepare('UPDATE stream_stats SET views = views + 1, last_viewed = ? WHERE id = ?').run(now, existingStat.id);
    } else {
      db.prepare('INSERT INTO stream_stats (channel_id, views, last_viewed) VALUES (?, 1, ?)').run(channel.provider_channel_id, now);
    }

    // Decrypt provider password
    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    const remoteUrl = `${base}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;

    // Fetch
    const upstream = await fetch(remoteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Connection': 'keep-alive'
      },
      redirect: 'follow'
    });

    if (!upstream.ok || !upstream.body) {
      console.error(`Movie proxy error: ${upstream.status} ${upstream.statusText} for ${remoteUrl}`);
      activeStreams.delete(connectionId);
      return res.sendStatus(502);
    }

    // Pass headers
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);

    upstream.body.on('error', (err) => {
      console.error('Movie stream error:', err.message);
      activeStreams.delete(connectionId);
    });

    req.on('close', () => {
      activeStreams.delete(connectionId);
      if (upstream.body && !upstream.body.destroyed) upstream.body.destroy();
    });

  } catch (e) {
    console.error('Movie proxy error:', e.message);
    activeStreams.delete(connectionId);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// === Series Episode Proxy ===
app.get('/series/:username/:password/:episode_id.:ext', async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const epIdRaw = Number(req.params.episode_id || 0);
    const ext = req.params.ext;

    if (!epIdRaw) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    // Decode Episode ID
    const OFFSET = 1000000000;
    const providerId = Math.floor(epIdRaw / OFFSET);
    const remoteEpisodeId = epIdRaw % OFFSET;

    if (!providerId || !remoteEpisodeId) return res.sendStatus(404);

    // Get Provider
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider) return res.sendStatus(404);

    // Track active stream
    const startTime = Date.now();
    activeStreams.set(connectionId, {
      id: connectionId,
      user_id: user.id,
      username: user.username,
      channel_name: `Series Episode ${remoteEpisodeId}`,
      start_time: startTime,
      ip: req.ip
    });

    provider.password = decrypt(provider.password);

    const base = provider.url.replace(/\/+$/, '');
    const remoteUrl = `${base}/series/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${remoteEpisodeId}.${ext}`;

    // Fetch
    const upstream = await fetch(remoteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Connection': 'keep-alive'
      },
      redirect: 'follow'
    });

    if (!upstream.ok || !upstream.body) {
      console.error(`Series proxy error: ${upstream.status} ${upstream.statusText} for ${remoteUrl}`);
      activeStreams.delete(connectionId);
      return res.sendStatus(502);
    }

    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);

    upstream.body.on('error', (err) => {
      console.error('Series stream error:', err.message);
      activeStreams.delete(connectionId);
    });

    req.on('close', () => {
      activeStreams.delete(connectionId);
      if (upstream.body && !upstream.body.destroyed) upstream.body.destroy();
    });

  } catch (e) {
    console.error('Series proxy error:', e.message);
    activeStreams.delete(connectionId);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// === Timeshift Proxy ===
app.get('/timeshift/:username/:password/:duration/:start/:stream_id.ts', async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const streamId = Number(req.params.stream_id || 0);
    const duration = req.params.duration;
    const start = req.params.start;

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.id as provider_channel_id,
        pc.remote_stream_id,
        pc.name,
        p.url as provider_url,
        p.username as provider_user,
        p.password as provider_pass
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE uc.id = ? AND cat.user_id = ?
    `).get(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    // Track active stream (optional for timeshift? might be good to track)
    const startTime = Date.now();
    activeStreams.set(connectionId, {
      id: connectionId,
      user_id: user.id,
      username: user.username,
      channel_name: `${channel.name} (Timeshift)`,
      start_time: startTime,
      ip: req.ip
    });

    // Decrypt provider password
    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    // Standard Xtream Timeshift URL: /timeshift/user/pass/duration/start/id.ts
    const remoteUrl = `${base}/timeshift/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${duration}/${start}/${channel.remote_stream_id}.ts`;

    // Fetch with optimized settings for streaming
    const upstream = await fetch(remoteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Connection': 'keep-alive'
      },
      redirect: 'follow'
    });

    if (!upstream.ok || !upstream.body) {
      console.error(`Timeshift proxy error: ${upstream.status} ${upstream.statusText} for ${remoteUrl}`);
      activeStreams.delete(connectionId);
      return res.sendStatus(502);
    }

    // Set optimal headers for streaming
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    upstream.body.pipe(res);

    upstream.body.on('error', (err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.type !== 'aborted') {
        console.error('Timeshift stream error:', err.message);
      }
      activeStreams.delete(connectionId);
      if (!res.headersSent) {
        res.sendStatus(502);
      }
    });

    req.on('close', () => {
      activeStreams.delete(connectionId);
      if (upstream.body && !upstream.body.destroyed) {
        upstream.body.destroy();
      }
    });

  } catch (e) {
    console.error('Timeshift proxy error:', e.message);
    activeStreams.delete(connectionId);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
});

// === Statistics API ===
app.get('/api/statistics', authenticateToken, (req, res) => {
  try {
    // Top Channels
    const topChannels = db.prepare(`
      SELECT ss.views, ss.last_viewed, pc.name, pc.logo
      FROM stream_stats ss
      JOIN provider_channels pc ON pc.id = ss.channel_id
      ORDER BY ss.views DESC
      LIMIT 10
    `).all();

    // Active Streams
    const streams = Array.from(activeStreams.values()).map(s => ({
      ...s,
      duration: Math.floor((Date.now() - s.start_time) / 1000)
    }));

    res.json({
      active_streams: streams,
      top_channels: topChannels
    });
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === XMLTV ===
app.get('/xmltv.php', async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    // Collect all EPG data from cache
    const epgFiles = [];
    
    // Get provider EPG files
    const providers = db.prepare("SELECT id FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
    for (const provider of providers) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
      if (fs.existsSync(cacheFile)) {
        epgFiles.push(cacheFile);
      }
    }
    
    // Get EPG source files
    const sources = db.prepare('SELECT id FROM epg_sources WHERE enabled = 1').all();
    for (const source of sources) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_${source.id}.xml`);
      if (fs.existsSync(cacheFile)) {
        epgFiles.push(cacheFile);
      }
    }
    
    if (epgFiles.length === 0) {
      // Fallback to provider EPG URL if no cache
      const provider = db.prepare("SELECT * FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != '' LIMIT 1").get();
      if (provider && provider.epg_url) {
        const upstream = await fetch(provider.epg_url);
        if (upstream.ok && upstream.body) {
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          return upstream.body.pipe(res);
        }
      }
      return res.status(404).send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
    }
    
    // Merge all EPG files
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');
    
    for (const file of epgFiles) {
      await streamEpgContent(file, res);
    }
    
    res.write('</tv>');
    res.end();
  } catch (e) {
    console.error('xmltv error:', e.message);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
  }
});

// === DELETE APIs ===
app.delete('/api/providers/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);

    db.transaction(() => {
      // Delete related data first to satisfy FK constraints and prevent orphans
      db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM sync_configs WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM sync_logs WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM category_mappings WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/user-categories/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    
    // Delete in correct order to avoid foreign key constraints
    // 1. Delete channels in this category
    db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(id);
    
    // 2. Update category mappings (set user_category_id to NULL instead of deleting)
    db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id = ?').run(id);
    
    // 3. Delete the category itself
    db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);
    
    res.json({success: true});
  } catch (e) {
    console.error('Delete category error:', e);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/user-categories/bulk-delete', authenticateToken, (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({error: 'ids array required'});

    db.transaction(() => {
      for (const id of ids) {
         db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(id);
         db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id = ?').run(id);
         db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);
      }
    })();

    res.json({success: true, deleted: ids.length});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/user-channels/bulk-delete', authenticateToken, (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({error: 'ids array required'});

    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM user_channels WHERE id IN (${placeholders})`).run(...ids);

    res.json({success: true, deleted: ids.length});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/user-channels/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM user_channels WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/users/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);

    db.transaction(() => {
      // 1. Delete owned providers and their dependencies
      const userProviders = db.prepare('SELECT id FROM providers WHERE user_id = ?').all(id);
      for (const p of userProviders) {
        db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM sync_configs WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM sync_logs WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM category_mappings WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM providers WHERE id = ?').run(p.id);
      }

      // 2. Delete user data
      db.prepare('DELETE FROM user_channels WHERE user_category_id IN (SELECT id FROM user_categories WHERE user_id = ?)').run(id);

      // Update mappings to remove user_category_id reference before deleting categories
      db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_id = ?').run(id);

      db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(id);

      // Delete sync data
      db.prepare('DELETE FROM sync_configs WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM sync_logs WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM category_mappings WHERE user_id = ?').run(id);

      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === Sync Config APIs ===
app.get('/api/sync-configs', authenticateToken, (req, res) => {
  try {
    const configs = db.prepare(`
      SELECT sc.*, p.name as provider_name, u.username
      FROM sync_configs sc
      JOIN providers p ON p.id = sc.provider_id
      JOIN users u ON u.id = sc.user_id
      ORDER BY sc.id
    `).all();
    res.json(configs);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.get('/api/sync-configs/:providerId/:userId', authenticateToken, (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?')
      .get(Number(req.params.providerId), Number(req.params.userId));
    res.json(config || null);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/sync-configs', authenticateToken, (req, res) => {
  try {
    const { provider_id, user_id, enabled, sync_interval, auto_add_categories, auto_add_channels } = req.body;
    
    if (!provider_id || !user_id) {
      return res.status(400).json({error: 'provider_id and user_id required'});
    }
    
    const nextSync = calculateNextSync(sync_interval || 'daily');
    
    const info = db.prepare(`
      INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval, next_sync, auto_add_categories, auto_add_channels)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider_id,
      user_id,
      enabled ? 1 : 0,
      sync_interval || 'daily',
      nextSync,
      auto_add_categories ? 1 : 0,
      auto_add_channels ? 1 : 0
    );
    
    // Restart scheduler
    startSyncScheduler();
    
    res.json({id: info.lastInsertRowid});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.put('/api/sync-configs/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { enabled, sync_interval, auto_add_categories, auto_add_channels } = req.body;
    
    const config = db.prepare('SELECT * FROM sync_configs WHERE id = ?').get(id);
    if (!config) return res.status(404).json({error: 'not found'});
    
    const nextSync = calculateNextSync(sync_interval || config.sync_interval);
    
    db.prepare(`
      UPDATE sync_configs
      SET enabled = ?, sync_interval = ?, next_sync = ?, auto_add_categories = ?, auto_add_channels = ?
      WHERE id = ?
    `).run(
      enabled !== undefined ? (enabled ? 1 : 0) : config.enabled,
      sync_interval || config.sync_interval,
      nextSync,
      auto_add_categories !== undefined ? (auto_add_categories ? 1 : 0) : config.auto_add_categories,
      auto_add_channels !== undefined ? (auto_add_channels ? 1 : 0) : config.auto_add_channels,
      id
    );
    
    // Restart scheduler
    startSyncScheduler();
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/sync-configs/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM sync_configs WHERE id = ?').run(id);
    
    // Restart scheduler
    startSyncScheduler();
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === Sync Logs APIs ===
app.get('/api/sync-logs', authenticateToken, (req, res) => {
  try {
    const { provider_id, user_id, limit } = req.query;
    let query = `
      SELECT sl.*, p.name as provider_name, u.username
      FROM sync_logs sl
      JOIN providers p ON p.id = sl.provider_id
      JOIN users u ON u.id = sl.user_id
      WHERE 1=1
    `;
    const params = [];
    
    if (provider_id) {
      query += ' AND sl.provider_id = ?';
      params.push(Number(provider_id));
    }
    
    if (user_id) {
      query += ' AND sl.user_id = ?';
      params.push(Number(user_id));
    }
    
    query += ' ORDER BY sl.sync_time DESC';
    
    if (limit) {
      query += ' LIMIT ?';
      params.push(Number(limit));
    }
    
    const logs = db.prepare(query).all(...params);
    res.json(logs);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === Category Mappings APIs ===
app.get('/api/category-mappings/:providerId/:userId', authenticateToken, (req, res) => {
  try {
    const mappings = db.prepare(`
      SELECT cm.*, uc.name as user_category_name
      FROM category_mappings cm
      LEFT JOIN user_categories uc ON uc.id = cm.user_category_id
      WHERE cm.provider_id = ? AND cm.user_id = ?
      ORDER BY cm.provider_category_name
    `).all(Number(req.params.providerId), Number(req.params.userId));
    res.json(mappings);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.put('/api/category-mappings/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { user_category_id } = req.body;
    
    db.prepare('UPDATE category_mappings SET user_category_id = ? WHERE id = ?')
      .run(user_category_id ? Number(user_category_id) : null, id);
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === UPDATE APIs ===
app.put('/api/user-categories/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});
    
    const isAdult = isAdultCategory(name) ? 1 : 0;
    db.prepare('UPDATE user_categories SET name = ?, is_adult = ? WHERE id = ?').run(name.trim(), isAdult, id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.put('/api/providers/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled } = req.body;
    if (!name || !url || !username || !password) {
      return res.status(400).json({error: 'missing fields'});
    }

    // Validate URL
    if (!/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URL must start with http:// or https://'});
    }

    if (epg_url && !/^https?:\/\//i.test(epg_url.trim())) {
      return res.status(400).json({error: 'invalid_epg_url', message: 'EPG URL must start with http:// or https://'});
    }

    // Get existing to check for masked password
    const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({error: 'provider not found'});

    let finalPassword = existing.password;
    // Only update password if it's not the mask
    if (password.trim() !== '********') {
       finalPassword = encrypt(password.trim());
    }

    let finalEpgUrl = (epg_url || '').trim();
    if (!finalEpgUrl) {
       // Auto-discover if empty
       try {
        const baseUrl = url.trim().replace(/\/+$/, '');
        // Use provided password or decrypt existing if masked
        const pwdToUse = password.trim() === '********' ? decrypt(existing.password) : password.trim();
        const usrToUse = username.trim();

        const discoveredUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(usrToUse)}&password=${encodeURIComponent(pwdToUse)}`;

        // Simple heuristic: if we are updating and URL/User/Pass changed, or just EPG is empty, try to fetch.
        // We only save it if we can confirm it (optional, but good practice).
        // Since this is PUT, let's just construct it if it's standard Xtream.
        finalEpgUrl = discoveredUrl;
       } catch(e) {}
    }

    db.prepare(`
      UPDATE providers
      SET name = ?, url = ?, username = ?, password = ?, epg_url = ?, user_id = ?, epg_update_interval = ?, epg_enabled = ?
      WHERE id = ?
    `).run(
      name.trim(),
      url.trim(),
      username.trim(),
      finalPassword,
      finalEpgUrl,
      user_id !== undefined ? (user_id ? Number(user_id) : null) : existing.user_id,
      epg_update_interval ? Number(epg_update_interval) : existing.epg_update_interval,
      epg_enabled !== undefined ? (epg_enabled ? 1 : 0) : existing.epg_enabled,
      id
    );
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.put('/api/user-categories/:id/adult', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { is_adult } = req.body;
    db.prepare('UPDATE user_categories SET is_adult = ? WHERE id = ?').run(is_adult ? 1 : 0, id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// EPG Update Function
async function updateEpgSource(sourceId) {
  const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error('EPG source not found');
  
  // Mark as updating
  db.prepare('UPDATE epg_sources SET is_updating = 1 WHERE id = ?').run(sourceId);
  
  try {
    console.log(`📡 Fetching EPG from: ${source.name}`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const epgData = await response.text();
    const now = Math.floor(Date.now() / 1000);
    
    // Save to cache file
    const cacheFile = path.join(EPG_CACHE_DIR, `epg_${sourceId}.xml`);
    await fs.promises.writeFile(cacheFile, epgData, 'utf8');
    
    // Update last_update timestamp
    db.prepare('UPDATE epg_sources SET last_update = ?, is_updating = 0 WHERE id = ?').run(now, sourceId);
    
    console.log(`✅ EPG updated: ${source.name} (${(epgData.length / 1024 / 1024).toFixed(2)} MB)`);
    return { success: true, size: epgData.length };
  } catch (e) {
    console.error(`❌ EPG update failed: ${source.name}`, e.message);
    db.prepare('UPDATE epg_sources SET is_updating = 0 WHERE id = ?').run(sourceId);
    throw e;
  }
}

// === EPG Sources APIs ===
app.get('/api/epg-sources', authenticateToken, (req, res) => {
  try {
    const sources = db.prepare('SELECT * FROM epg_sources ORDER BY name').all();
    
    // Add provider EPG sources
    const providers = db.prepare("SELECT id, name, epg_url, epg_update_interval FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
    const allSources = [
      ...providers.map(p => {
        let lastUpdate = 0;
        const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${p.id}.xml`);
        if (fs.existsSync(cacheFile)) {
          try {
            lastUpdate = Math.floor(fs.statSync(cacheFile).mtimeMs / 1000);
          } catch(e) {}
        }

        return {
          id: `provider_${p.id}`,
          name: `${p.name} (Provider EPG)`,
          url: p.epg_url,
          enabled: 1,
          last_update: lastUpdate,
          update_interval: p.epg_update_interval || 86400,
          source_type: 'provider',
          is_updating: 0
        };
      }),
      ...sources
    ];
    
    res.json(allSources);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/epg-sources', authenticateToken, (req, res) => {
  try {
    const { name, url, enabled, update_interval, source_type } = req.body;
    if (!name || !url) return res.status(400).json({error: 'name and url required'});
    
    const info = db.prepare(`
      INSERT INTO epg_sources (name, url, enabled, update_interval, source_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      url.trim(),
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
      update_interval || 86400,
      source_type || 'custom'
    );
    
    res.json({id: info.lastInsertRowid});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.put('/api/epg-sources/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, url, enabled, update_interval } = req.body;
    
    const updates = [];
    const params = [];
    
    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (url !== undefined) {
      updates.push('url = ?');
      params.push(url.trim());
    }
    if (enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }
    if (update_interval !== undefined) {
      updates.push('update_interval = ?');
      params.push(update_interval);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({error: 'no fields to update'});
    }
    
    params.push(id);
    db.prepare(`UPDATE epg_sources SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/epg-sources/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    
    // Delete cache file
    const cacheFile = path.join(EPG_CACHE_DIR, `epg_${id}.xml`);
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
    
    db.prepare('DELETE FROM epg_sources WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Update single EPG source
app.post('/api/epg-sources/:id/update', authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;
    
    // Check if it's a provider EPG
    if (id.startsWith('provider_')) {
      const providerId = Number(id.replace('provider_', ''));
      const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
      if (!provider || !provider.epg_url) {
        return res.status(404).json({error: 'Provider EPG not found'});
      }
      
      // Fetch and cache provider EPG
      const response = await fetch(provider.epg_url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const epgData = await response.text();
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${providerId}.xml`);
      fs.writeFileSync(cacheFile, epgData, 'utf8');
      
      return res.json({success: true, size: epgData.length});
    }
    
    // Regular EPG source
    const result = await updateEpgSource(Number(id));
    res.json(result);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Update all EPG sources
app.post('/api/epg-sources/update-all', authenticateToken, async (req, res) => {
  try {
    const sources = db.prepare('SELECT id FROM epg_sources WHERE enabled = 1').all();
    const providers = db.prepare("SELECT * FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != '' AND epg_enabled = 1").all();
    
    // Update provider EPGs in parallel
    const providerPromises = providers.map(async (provider) => {
      try {
        // Fetch provider EPG using URL directly from the provider object
        const response = await fetch(provider.epg_url);
        if (response.ok) {
          const epgData = await response.text();
          const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
          await fs.promises.writeFile(cacheFile, epgData, 'utf8');
          return {id: `provider_${provider.id}`, success: true};
        }
        throw new Error(`HTTP ${response.status}`);
      } catch (e) {
        return {id: `provider_${provider.id}`, success: false, error: e.message};
      }
    });
    
    // Update regular EPG sources in parallel
    const sourcePromises = sources.map(async (source) => {
      try {
        await updateEpgSource(source.id);
        return {id: source.id, success: true};
      } catch (e) {
        return {id: source.id, success: false, error: e.message};
      }
    });

    const results = await Promise.all([...providerPromises, ...sourcePromises]);
    
    res.json({success: true, results});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Get available EPG sources from local JSON
app.get('/api/epg-sources/available', authenticateToken, async (req, res) => {
  try {
    const jsonPath = path.join(__dirname, '../public', 'epg_sources.json');
    if (!fs.existsSync(jsonPath)) {
      return res.json([]);
    }
    const content = await fs.promises.readFile(jsonPath, 'utf8');
    const data = JSON.parse(content);
    // Map to expected format if needed, but the JSON structure seems compatible
    // The existing frontend expects {name, url, size, country}
    // The JSON has {name, url, country_code, description}
    // We can map it to match frontend expectation
    
    const sources = (data.epg_sources || []).map(s => ({
      name: s.name,
      url: s.url,
      size: 0, // Unknown size, optional
      country: s.country_code // Use country_code as country
    }));
    
    res.json(sources);
  } catch (e) {
    console.error('EPG sources error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// === EPG Mapping APIs ===
async function loadAllEpgChannels() {
  const epgFiles = [];

  const providers = db.prepare("SELECT id FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
  for (const provider of providers) {
    const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
    if (fs.existsSync(cacheFile)) {
      epgFiles.push({ file: cacheFile, source: `Provider ${provider.id}` });
    }
  }

  const sources = db.prepare('SELECT id, name FROM epg_sources WHERE enabled = 1').all();
  for (const source of sources) {
    const cacheFile = path.join(EPG_CACHE_DIR, `epg_${source.id}.xml`);
    if (fs.existsSync(cacheFile)) {
      epgFiles.push({ file: cacheFile, source: source.name });
    }
  }

  const allChannels = [];
  const seenIds = new Set();

  for (const item of epgFiles) {
    try {
      const content = await fs.promises.readFile(item.file, 'utf8');
      const channelRegex = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
      let match;
      while ((match = channelRegex.exec(content)) !== null) {
        const id = match[1];
        if (seenIds.has(id)) continue;

        const inner = match[2];
        const nameMatch = inner.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
        const iconMatch = inner.match(/<icon[^>]+src="([^"]+)"/);

        allChannels.push({
          id: id,
          name: nameMatch ? nameMatch[1] : id,
          logo: iconMatch ? iconMatch[1] : null,
          source: item.source
        });
        seenIds.add(id);
      }
    } catch (e) {
      console.error(`Error reading EPG file ${item.file}:`, e);
    }
  }
  return allChannels;
}

app.get('/api/epg/channels', authenticateToken, async (req, res) => {
  try {
    const channels = await loadAllEpgChannels();
    res.json(channels);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/mapping/manual', authenticateToken, (req, res) => {
  try {
    const { provider_channel_id, epg_channel_id } = req.body;
    if (!provider_channel_id || !epg_channel_id) return res.status(400).json({error: 'missing fields'});

    db.prepare(`
      INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id)
      VALUES (?, ?)
      ON CONFLICT(provider_channel_id) DO UPDATE SET epg_channel_id = excluded.epg_channel_id
    `).run(Number(provider_channel_id), epg_channel_id);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/mapping/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.get('/api/mapping/:providerId', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.providerId);
    const mappings = db.prepare('SELECT * FROM epg_channel_mappings WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').all(id);
    const map = {};
    mappings.forEach(m => map[m.provider_channel_id] = m.epg_channel_id);
    res.json(map);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/mapping/auto', authenticateToken, async (req, res) => {
  try {
    const { provider_id } = req.body;
    if (!provider_id) return res.status(400).json({error: 'provider_id required'});

    // Get unmapped channels
    const channels = db.prepare(`
      SELECT pc.id, pc.name, pc.epg_channel_id
      FROM provider_channels pc
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE pc.provider_id = ? AND map.id IS NULL
    `).all(Number(provider_id));

    if (channels.length === 0) return res.json({matched: 0, message: 'No unmapped channels found'});

    // Load Global Mappings (from other providers)
    const globalMappings = db.prepare(`
      SELECT pc.name, map.epg_channel_id
      FROM epg_channel_mappings map
      JOIN provider_channels pc ON pc.id = map.provider_channel_id
    `).all();

    const globalMap = new Map();
    for (const m of globalMappings) {
        const clean = cleanName(m.name);
        if (clean) globalMap.set(clean, m.epg_channel_id);
    }

    const epgList = await loadAllEpgChannels();
    const epgChannels = new Map();
    for (const ch of epgList) {
       if (ch.name) epgChannels.set(cleanName(ch.name), ch.id);
    }

    let matched = 0;
    const insert = db.prepare(`
      INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id)
      VALUES (?, ?)
      ON CONFLICT(provider_channel_id) DO UPDATE SET epg_channel_id = excluded.epg_channel_id
    `);

    const updates = [];

    for (const ch of channels) {
       const cleaned = cleanName(ch.name);
       if (!cleaned) continue;

       // 1. Try Global Map
       let epgId = globalMap.get(cleaned);

       // 2. Try Exact Match
       if (!epgId) {
         epgId = epgChannels.get(cleaned);
       }

       // 3. Fuzzy Match
       if (!epgId) {
         // Fuzzy match with Levenshtein
         // Optimization: Only check channels with similar length
         for (const [epgName, id] of epgChannels.entries()) {
           // Optimization: length diff check
           if (Math.abs(epgName.length - cleaned.length) > 3) continue;

           // Don't fuzzy match very short strings to avoid false positives
           if (cleaned.length < 4) continue;

           if (levenshtein(cleaned, epgName) < 3) {
              epgId = id;
              break;
           }
         }
       }

       if (epgId) {
         updates.push({pid: ch.id, eid: epgId});
         matched++;
       }
    }

    if (updates.length > 0) {
      db.transaction(() => {
        for (const u of updates) {
          insert.run(u.pid, u.eid);
        }
      })();
    }

    res.json({success: true, matched});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === Settings API ===
app.get('/api/settings', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/settings', authenticateToken, (req, res) => {
  try {
    const settings = req.body;
    const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        insert.run(key, String(value));
      }
    })();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// === Client Logs API ===
app.post('/api/client-logs', (req, res) => {
  try {
    // Rate limit? Maybe rely on general limiter.
    const { level, message, stack, user_agent } = req.body;
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO client_logs (level, message, stack, user_agent, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(level || 'error', message || 'Unknown', stack || '', user_agent || '', now);
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/client-logs', authenticateToken, (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const logs = db.prepare('SELECT * FROM client_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
    res.json(logs);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/client-logs', authenticateToken, (req, res) => {
  try {
    db.prepare('DELETE FROM client_logs').run();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// === Security API ===
app.get('/api/security/logs', authenticateToken, (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const logs = db.prepare('SELECT * FROM security_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
    res.json(logs);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/security/logs', authenticateToken, (req, res) => {
  try {
    db.prepare('DELETE FROM security_logs').run();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/security/blocked', authenticateToken, (req, res) => {
  try {
    const ips = db.prepare('SELECT * FROM blocked_ips ORDER BY created_at DESC').all();
    res.json(ips);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/security/block', authenticateToken, (req, res) => {
  try {
    const { ip, reason, duration } = req.body; // duration in seconds
    if (!ip) return res.status(400).json({error: 'ip required'});

    // Check whitelist
    const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);
    if (whitelisted) {
      return res.status(400).json({error: 'IP is whitelisted. Remove from whitelist first.'});
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (Number(duration) || 3600);

    db.prepare(`
      INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET expires_at = excluded.expires_at, reason = excluded.reason
    `).run(ip, reason || 'Manual Block', expiresAt);

    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_blocked', `Manual Block: ${reason || 'No reason'}`, now);

    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/security/block/:id', authenticateToken, (req, res) => {
  try {
    const id = req.params.id;
    const now = Math.floor(Date.now() / 1000);
    let ipToLog = id;

    // Check if it looks like an IP or ID
    if (id.includes('.') || id.includes(':')) {
       const info = db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(id);
       if (info.changes > 0) {
          db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(id, 'ip_unblocked', 'Manual Unblock', now);
       }
    } else {
       const entry = db.prepare('SELECT ip FROM blocked_ips WHERE id = ?').get(id);
       if (entry) {
          ipToLog = entry.ip;
          db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(id);
          db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ipToLog, 'ip_unblocked', 'Manual Unblock', now);
       }
    }
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.get('/api/security/whitelist', authenticateToken, (req, res) => {
  try {
    const ips = db.prepare('SELECT * FROM whitelisted_ips ORDER BY created_at DESC').all();
    res.json(ips);
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/security/whitelist', authenticateToken, (req, res) => {
  try {
    const { ip, description } = req.body;
    if (!ip) return res.status(400).json({error: 'ip required'});

    db.prepare('INSERT OR REPLACE INTO whitelisted_ips (ip, description) VALUES (?, ?)').run(ip, description || '');
    // Also remove from blocked if exists
    const info = db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(ip);

    if (info.changes > 0) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_unblocked', 'Automatically unblocked due to whitelisting', now);
    }

    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/security/whitelist/:id', authenticateToken, (req, res) => {
  try {
     const id = req.params.id;
     if (id.includes('.') || id.includes(':')) {
        db.prepare('DELETE FROM whitelisted_ips WHERE ip = ?').run(id);
     } else {
        db.prepare('DELETE FROM whitelisted_ips WHERE id = ?').run(id);
     }
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// === Import/Export API ===
app.get('/api/export', authenticateToken, (req, res) => {
  try {
    const { user_id, password } = req.query;

    if (!password) {
      return res.status(400).json({error: 'Password required for encryption'});
    }

    const exportData = {
      version: 1,
      timestamp: Date.now(),
      users: [],
      providers: [],
      categories: [],
      channels: [],
      mappings: [],
      sync_configs: []
    };

    let usersToExport = [];
    if (user_id && user_id !== 'all') {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
      if (!user) return res.status(404).json({error: 'User not found'});
      usersToExport.push(user);
    } else {
      usersToExport = db.prepare('SELECT * FROM users').all();
    }

    // Collect Data
    for (const user of usersToExport) {
       exportData.users.push(user);

       // Providers
       const providers = db.prepare('SELECT * FROM providers WHERE user_id = ?').all(user.id);
       for (const p of providers) {
          // Decrypt password so it can be re-encrypted on import
          p.password = decrypt(p.password);
          exportData.providers.push(p);

          // Provider Channels
          const channels = db.prepare('SELECT * FROM provider_channels WHERE provider_id = ?').all(p.id);
          exportData.channels.push(...channels);

          // Mappings
          const mappings = db.prepare('SELECT * FROM category_mappings WHERE provider_id = ?').all(p.id);
          exportData.mappings.push(...mappings);

          // Sync Configs
          const syncs = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ?').all(p.id);
          exportData.sync_configs.push(...syncs);
       }

       // User Categories
       const categories = db.prepare('SELECT * FROM user_categories WHERE user_id = ?').all(user.id);
       exportData.categories.push(...categories);

       // User Channels (assignments)
       // We need to fetch user channels linked to these categories
       const userChannels = db.prepare(`
         SELECT uc.*
         FROM user_channels uc
         JOIN user_categories cat ON cat.id = uc.user_category_id
         WHERE cat.user_id = ?
       `).all(user.id);
       exportData.channels.push(...userChannels.map(uc => ({...uc, type: 'user_assignment'})));
    }

    // Compress
    const jsonStr = JSON.stringify(exportData);
    const compressed = zlib.gzipSync(jsonStr);

    // Encrypt
    const encrypted = encryptWithPassword(compressed, password);

    res.setHeader('Content-Disposition', `attachment; filename="iptv_export_${Date.now()}.bin"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(encrypted);

  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/import', authenticateToken, upload.single('file'), (req, res) => {
  let tempPath = null;
  try {
    const { password } = req.body;
    if (!req.file || !password) {
      return res.status(400).json({error: 'File and password required'});
    }

    tempPath = req.file.path;
    const encryptedData = fs.readFileSync(tempPath);

    // Decrypt
    let compressed;
    try {
      compressed = decryptWithPassword(encryptedData, password);
    } catch (e) {
      return res.status(400).json({error: 'Decryption failed. Wrong password?'});
    }

    // Decompress
    const jsonStr = zlib.gunzipSync(compressed).toString('utf8');
    const importData = JSON.parse(jsonStr);

    if (!importData.version || !importData.users) {
      return res.status(400).json({error: 'Invalid export file format'});
    }

    const stats = {
      users_imported: 0,
      users_skipped: 0,
      providers: 0,
      categories: 0,
      channels: 0
    };

    db.transaction(() => {
      // 1. Import Users
      // ID Map to map old IDs to new IDs
      const userIdMap = new Map();
      const providerIdMap = new Map();
      const categoryIdMap = new Map();
      const providerChannelIdMap = new Map();

      for (const user of importData.users) {
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(user.username);
        if (existing) {
          console.log(`Skipping existing user: ${user.username}`);
          stats.users_skipped++;
          continue; // Skip existing user to avoid conflict
        }

        const info = db.prepare('INSERT INTO users (username, password, is_active) VALUES (?, ?, ?)').run(user.username, user.password, user.is_active);
        userIdMap.set(user.id, info.lastInsertRowid);
        stats.users_imported++;
      }

      // 2. Import Providers
      for (const p of importData.providers) {
        const newUserId = userIdMap.get(p.user_id);
        if (!newUserId) continue; // User was skipped or not found

        // Re-encrypt password with local key
        const newPassword = encrypt(p.password);

        const info = db.prepare(`
          INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(p.name, p.url, p.username, newPassword, p.epg_url, newUserId, p.epg_update_interval, p.epg_enabled);

        providerIdMap.set(p.id, info.lastInsertRowid);
        stats.providers++;
      }

      // 3. Import Provider Channels
      // We filter channels that belong to imported providers
      const provChannels = importData.channels.filter(c => !c.type && providerIdMap.has(c.provider_id));

      const insertProvChannel = db.prepare(`
        INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order, tv_archive, tv_archive_duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const ch of provChannels) {
        const newProvId = providerIdMap.get(ch.provider_id);
        const info = insertProvChannel.run(
          newProvId,
          ch.remote_stream_id,
          ch.name,
          ch.original_category_id,
          ch.logo,
          ch.stream_type,
          ch.epg_channel_id,
          ch.original_sort_order,
          ch.tv_archive || 0,
          ch.tv_archive_duration || 0
        );
        providerChannelIdMap.set(ch.id, info.lastInsertRowid);
      }

      // 4. Import User Categories
      for (const cat of importData.categories) {
        const newUserId = userIdMap.get(cat.user_id);
        if (!newUserId) continue;

        // Check for type in export data, default to live
        const catType = cat.type || 'live';
        const info = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)').run(newUserId, cat.name, cat.is_adult, cat.sort_order, catType);
        categoryIdMap.set(cat.id, info.lastInsertRowid);
        stats.categories++;
      }

      // 5. Import Mappings
      for (const m of importData.mappings) {
        const newProvId = providerIdMap.get(m.provider_id);
        const newUserId = userIdMap.get(m.user_id);
        const newUserCatId = m.user_category_id ? categoryIdMap.get(m.user_category_id) : null;

        if (newProvId && newUserId) {
           db.prepare(`
             INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created)
             VALUES (?, ?, ?, ?, ?, ?)
           `).run(newProvId, newUserId, m.provider_category_id, m.provider_category_name, newUserCatId, m.auto_created);
        }
      }

      // 6. Import Sync Configs
      for (const s of importData.sync_configs) {
        const newProvId = providerIdMap.get(s.provider_id);
        const newUserId = userIdMap.get(s.user_id);

        if (newProvId && newUserId) {
          db.prepare(`
            INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval, last_sync, next_sync, auto_add_categories, auto_add_channels)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(newProvId, newUserId, s.enabled, s.sync_interval, 0, 0, s.auto_add_categories, s.auto_add_channels);
        }
      }

      // 7. Import User Channel Assignments
      const userAssignments = importData.channels.filter(c => c.type === 'user_assignment');
      const insertUserChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');

      for (const ua of userAssignments) {
        const newUserCatId = categoryIdMap.get(ua.user_category_id);
        const newProvChannelId = providerChannelIdMap.get(ua.provider_channel_id);

        if (newUserCatId && newProvChannelId) {
          insertUserChannel.run(newUserCatId, newProvChannelId, ua.sort_order);
          stats.channels++;
        }
      }

    })();

    res.json({success: true, stats});

  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({error: e.message});
  } finally {
    // Cleanup temp file
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch(e) {}
    }
  }
});

// Start
app.listen(PORT, () => {
  console.log(`✅ IPTV-Manager: http://localhost:${PORT}`);
});

// Helper function to stream EPG content efficiently
function streamEpgContent(file, res) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    let buffer = '';
    let foundStart = false;

    stream.on('data', (chunk) => {
      let currentChunk = buffer + chunk;
      buffer = '';

      if (!foundStart) {
        const startMatch = currentChunk.match(/<tv[^>]*>/);
        if (startMatch) {
          foundStart = true;
          const startIndex = startMatch.index + startMatch[0].length;
          currentChunk = currentChunk.substring(startIndex);
        } else {
          // Keep the last part of chunk to handle split tags
          const lastLt = currentChunk.lastIndexOf('<');
          if (lastLt !== -1) {
            buffer = currentChunk.substring(lastLt);
          }
          return;
        }
      }

      if (foundStart) {
        const endMatch = currentChunk.indexOf('</tv>');
        if (endMatch !== -1) {
          res.write(currentChunk.substring(0, endMatch));
          stream.destroy();
          resolve();
          return;
        } else {
          if (currentChunk.length >= 5) {
             const toWrite = currentChunk.substring(0, currentChunk.length - 4);
             res.write(toWrite);
             buffer = currentChunk.substring(currentChunk.length - 4);
          } else {
             buffer = currentChunk;
          }
        }
      }
    });

    stream.on('end', () => {
      if (buffer && buffer.length > 0) {
        res.write(buffer);
      }
      resolve();
    });
    stream.on('error', (err) => {
      console.error(`Error streaming EPG file ${file}:`, err.message);
      resolve(); // Continue even on error
    });
    stream.on('close', resolve);
  });
}
