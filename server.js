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

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// Security configuration
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 10;

// Create cache directories
const CACHE_DIR = path.join(__dirname, 'cache');
const EPG_CACHE_DIR = path.join(CACHE_DIR, 'epg');
// Picon caching removed - using direct URLs for better performance

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(EPG_CACHE_DIR)) fs.mkdirSync(EPG_CACHE_DIR, { recursive: true });

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for now
  crossOriginEmbedderPolicy: false
}));

// Rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
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
app.use(morgan('dev'));
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/cache', express.static(path.join(__dirname, 'cache')));

// DB
const db = new Database(path.join(__dirname, 'db.sqlite'));

// DB Init
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      epg_url TEXT
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
      UNIQUE(provider_id, remote_stream_id)
    );
    
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
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
      is_adult INTEGER DEFAULT 0
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
    
    -- Picon cache table removed - using direct URLs for better performance
  `);
  console.log("✅ Database OK");
  
  // Create default admin user if no users exist
  await createDefaultAdmin();
} catch (e) {
  console.error("❌ DB Error:", e.message);
  process.exit(1);
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
    
    const config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?').get(providerId, userId);
    if (!config && !isManual) return;
    
    console.log(`🔄 Starting sync for provider ${provider.name} (user ${userId})`);
    
    // Fetch channels from provider
    const xtream = createXtreamClient(provider);
    let channels = [];
    
    try { 
      channels = await xtream.getChannels(); 
    } catch {
      try { 
        channels = await xtream.getLiveStreams(); 
      } catch {
        const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_streams`;
        const resp = await fetch(apiUrl);
        channels = resp.ok ? await resp.json() : [];
      }
    }
    
    // Fetch categories from provider
    let providerCategories = [];
    try {
      const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_categories`;
      const resp = await fetch(apiUrl);
      if (resp.ok) {
        providerCategories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }
    
    // Process categories and create mappings
    const categoryMap = new Map();
    
    // Check if this is the first sync (no existing mappings)
    const existingMappingsCount = db.prepare(`
      SELECT COUNT(*) as count FROM category_mappings 
      WHERE provider_id = ? AND user_id = ?
    `).get(providerId, userId);
    
    const isFirstSync = existingMappingsCount.count === 0;
    
    for (const provCat of providerCategories) {
      const catId = Number(provCat.category_id);
      const catName = provCat.category_name;
      
      // Check if mapping exists
      let mapping = db.prepare(`
        SELECT * FROM category_mappings 
        WHERE provider_id = ? AND user_id = ? AND provider_category_id = ?
      `).get(providerId, userId, catId);
      
      // Auto-create categories if:
      // 1. No mapping exists AND not first sync AND auto_add enabled
      // This means it's a NEW category from the provider
      const shouldAutoCreate = config && config.auto_add_categories && !mapping && !isFirstSync;
      
      if (shouldAutoCreate) {
        // Create new user category
        const isAdult = isAdultCategory(catName) ? 1 : 0;
        const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
        const newSortOrder = (maxSort?.max_sort || -1) + 1;
        
        const catInfo = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (?, ?, ?, ?)').run(userId, catName, isAdult, newSortOrder);
        const newCategoryId = catInfo.lastInsertRowid;
        
        // Create new mapping (only for new categories)
        db.prepare(`
          INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(providerId, userId, catId, catName, newCategoryId);
        
        categoryMap.set(catId, newCategoryId);
        categoriesAdded++;
        console.log(`  ✅ Created category: ${catName} (id=${newCategoryId})`);
      } else if (!mapping && isFirstSync) {
        // First sync: Create mapping without user category (user will create/import manually)
        db.prepare(`
          INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created)
          VALUES (?, ?, ?, ?, NULL, 0)
        `).run(providerId, userId, catId, catName);
        console.log(`  📋 Registered category: ${catName} (no auto-create on first sync)`);
      } else if (mapping && mapping.user_category_id) {
        categoryMap.set(catId, mapping.user_category_id);
      }
    }
    
    // Load all existing mappings into categoryMap
    const existingMappings = db.prepare(`
      SELECT provider_category_id, user_category_id 
      FROM category_mappings 
      WHERE provider_id = ? AND user_id = ? AND user_category_id IS NOT NULL
    `).all(providerId, userId);
    
    for (const mapping of existingMappings) {
      categoryMap.set(Number(mapping.provider_category_id), mapping.user_category_id);
    }
    
    // Process channels
    const insertChannel = db.prepare(`
      INSERT OR IGNORE INTO provider_channels
      (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const updateChannel = db.prepare(`
      UPDATE provider_channels 
      SET name = ?, original_category_id = ?, logo = ?, epg_channel_id = ?
      WHERE provider_id = ? AND remote_stream_id = ?
    `);
    
    const checkExisting = db.prepare('SELECT id FROM provider_channels WHERE provider_id = ? AND remote_stream_id = ?');
    
    db.transaction(() => {
      for (const ch of (channels || [])) {
        const sid = Number(ch.stream_id || ch.id || 0);
        if (sid > 0) {
          const existing = checkExisting.get(providerId, sid);
          
          if (existing) {
            // Update existing channel - preserves ID and user_channels relationships
            updateChannel.run(
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || '',
              ch.epg_channel_id || '',
              providerId,
              sid
            );
            channelsUpdated++;
          } else {
            // Insert new channel
            insertChannel.run(
              providerId,
              sid,
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || '',
              'live',
              ch.epg_channel_id || ''
            );
            channelsAdded++;
          }
          
          // Auto-add to user categories if enabled
          if (config && config.auto_add_channels) {
            const catId = Number(ch.category_id || 0);
            const userCatId = categoryMap.get(catId);
            
            if (userCatId) {
              const provChannelId = existing ? existing.id : db.prepare('SELECT id FROM provider_channels WHERE provider_id = ? AND remote_stream_id = ?').get(providerId, sid).id;
              
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
      // Generate random password
      const crypto = await import('crypto');
      const randomPassword = crypto.randomBytes(8).toString('hex');
      const username = 'admin';
      
      // Hash password
      const hashedPassword = await bcrypt.hash(randomPassword, BCRYPT_ROUNDS);
      
      // Create admin user in admin_users table (NOT in users table)
      db.prepare('INSERT INTO admin_users (username, password, is_active) VALUES (?, ?, 1)')
        .run(username, hashedPassword);
      
      console.log('\\n' + '='.repeat(60));
      console.log('🔐 DEFAULT ADMIN USER CREATED (WebGUI Only)');
      console.log('='.repeat(60));
      console.log(`Username: ${username}`);
      console.log(`Password: ${randomPassword}`);
      console.log('='.repeat(60));
      console.log('⚠️  IMPORTANT: Please change this password after first login!');
      console.log('ℹ️  NOTE: Admin user is for WebGUI only, not for IPTV streams!');
      console.log('='.repeat(60) + '\\n');
      
      // Save credentials to file for reference
      const fs = await import('fs');
      const credentialsFile = path.join(__dirname, 'ADMIN_CREDENTIALS.txt');
      const credentialsContent = `IPTV-Manager Default Admin Credentials\nGenerated: ${new Date().toISOString()}\n\nUsername: ${username}\nPassword: ${randomPassword}\n\n⚠️ IMPORTANT: \n- Change this password immediately after first login\n- Delete this file after noting the credentials\n- Keep these credentials secure\n- This admin user is for WebGUI management only\n- Create separate users for IPTV stream access\n`;
      
      fs.writeFileSync(credentialsFile, credentialsContent);
      console.log(`📄 Credentials also saved to: ${credentialsFile}\\n`);
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
    
    // Compare password with hashed password
    const isValid = await bcrypt.compare(p, user.password);
    return isValid ? user : null;
  } catch (e) {
    console.error('authUser error:', e);
    return null;
  }
}

// === API: Users ===
app.get('/api/users', authenticateToken, (req, res) => {
  try {
    res.json(db.prepare('SELECT id, username, is_active FROM users ORDER BY id').all());
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/users', authLimiter, async (req, res) => {
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
    
    // Hash password
    const hashedPassword = await bcrypt.hash(p, BCRYPT_ROUNDS);
    
    // Insert user
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(u, hashedPassword);
    
    res.json({
      id: info.lastInsertRowid,
      message: 'User created successfully'
    });
  } catch (e) { 
    res.status(400).json({error: e.message}); 
  }
});

// === API: Authentication ===
app.post('/api/login', authLimiter, async (req, res) => {
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
app.get('/api/providers', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM providers').all());
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/providers', (req, res) => {
  try {
    const { name, url, username, password, epg_url } = req.body;
    if (!name || !url || !username || !password) return res.status(400).json({error: 'missing'});
    const info = db.prepare('INSERT INTO providers (name, url, username, password, epg_url) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), url.trim(), username.trim(), password.trim(), (epg_url || '').trim());
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/providers/:id/sync', async (req, res) => {
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

app.get('/api/providers/:id/channels', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM provider_channels WHERE provider_id = ? ORDER BY name').all(Number(req.params.id));
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Provider-Kategorien abrufen
app.get('/api/providers/:id/categories', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!provider) return res.status(404).json({error: 'Provider not found'});

    let categories = [];
    
    try {
      const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_categories`;
      const resp = await fetch(apiUrl);
      if (resp.ok) {
        categories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }

    const localCats = db.prepare(`
      SELECT DISTINCT original_category_id, 
             COUNT(*) as channel_count
      FROM provider_channels 
      WHERE provider_id = ? AND original_category_id > 0
      GROUP BY original_category_id
      ORDER BY channel_count DESC
    `).all(id);

    const merged = categories.map(cat => {
      const local = localCats.find(l => Number(l.original_category_id) === Number(cat.category_id));
      const isAdult = isAdultCategory(cat.category_name);
      
      return {
        category_id: cat.category_id,
        category_name: cat.category_name,
        channel_count: local ? local.channel_count : 0,
        is_adult: isAdult
      };
    });

    res.json(merged);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// Provider-Kategorie importieren
app.post('/api/providers/:providerId/import-category', async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, category_id, category_name, import_channels } = req.body;
    
    if (!user_id || !category_id || !category_name) {
      return res.status(400).json({error: 'Missing required fields'});
    }

    const isAdult = isAdultCategory(category_name) ? 1 : 0;

    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(user_id);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const catInfo = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (?, ?, ?, ?)').run(user_id, category_name, isAdult, newSortOrder);
    const newCategoryId = catInfo.lastInsertRowid;

    if (import_channels) {
      const channels = db.prepare(`
        SELECT id FROM provider_channels 
        WHERE provider_id = ? AND original_category_id = ?
        ORDER BY name
      `).all(providerId, Number(category_id));

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

// === API: User Categories ===
app.get('/api/users/:userId/categories', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order').all(Number(req.params.userId)));
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/users/:userId/categories', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});
    
    const userId = Number(req.params.userId);
    const isAdult = isAdultCategory(name) ? 1 : 0;
    
    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;
    
    const info = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (?, ?, ?, ?)').run(userId, name.trim(), isAdult, newSortOrder);
    res.json({id: info.lastInsertRowid, is_adult: isAdult});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Kategorien neu sortieren
app.put('/api/users/:userId/categories/reorder', (req, res) => {
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

app.get('/api/user-categories/:catId/channels', (req, res) => {
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

app.post('/api/user-categories/:catId/channels', (req, res) => {
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
app.put('/api/user-categories/:catId/channels/reorder', (req, res) => {
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
    
    const user = await authUser(username, password);
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

    if (action === 'get_live_categories') {
      const cats = db.prepare('SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order').all(user.id);
      const result = cats.map(c => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }));
      return res.json(result);
    }

    if (action === 'get_live_streams') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.*, cat.is_adult as category_is_adult
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ?
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = await Promise.all(rows.map(async (ch, i) => {
        // Use direct picon URL - no caching needed
        let iconUrl = ch.logo || '';
        
        return {
          num: i + 1,
          name: ch.name,
          stream_type: 'live',
          stream_id: Number(ch.user_channel_id),
          stream_icon: iconUrl,
          epg_channel_id: ch.epg_channel_id || '',
          added: now.toString(),
          is_adult: ch.category_is_adult || 0,
          category_id: String(ch.user_category_id),
          category_ids: [Number(ch.user_category_id)],
          custom_sid: null,
          tv_archive: 0,
          direct_source: '',
          tv_archive_duration: 0
        };
      }));
      return res.json(result);
    }

    if (['get_vod_categories', 'get_series_categories', 'get_vod_streams', 'get_series'].includes(action)) {
      return res.json([]);
    }

    res.status(400).json([]);
  } catch (e) {
    console.error('player_api error:', e);
    res.status(500).json([]);
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
app.get('/live/:username/:password/:stream_id.ts', async (req, res) => {
  try {
    const username = (req.params.username || '').trim();
    const password = (req.params.password || '').trim();
    const streamId = Number(req.params.stream_id || 0);
    
    if (!streamId) return res.sendStatus(404);
    
    const user = await authUser(username, password);
    if (!user) return res.sendStatus(401);

    const channel = db.prepare(`
      SELECT
        uc.id as user_channel_id,
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

    const base = channel.provider_url.replace(/\/+$/, '');
    const remoteUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.ts`;
    
    // Fetch with optimized settings for streaming
    const upstream = await fetch(remoteUrl, {
      headers: {
        'User-Agent': 'IPTV-Manager/2.5.1',
        'Connection': 'keep-alive'
      },
      // Don't follow redirects automatically for better control
      redirect: 'follow'
      // No timeout - streams can run indefinitely
    });
    
    if (!upstream.ok || !upstream.body) {
      console.error(`Stream proxy error: ${upstream.status} ${upstream.statusText} for ${remoteUrl}`);
      return res.sendStatus(502);
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
      if (!res.headersSent) {
        res.sendStatus(502);
      }
    });
    
    // Handle client disconnect gracefully
    req.on('close', () => {
      if (upstream.body && !upstream.body.destroyed) {
        upstream.body.destroy();
      }
    });
    
  } catch (e) {
    console.error('Stream proxy error:', e.message);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
});

// === XMLTV ===
app.get('/xmltv.php', async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    
    const user = await authUser(username, password);
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
      try {
        const content = fs.readFileSync(file, 'utf8');
        // Extract content between <tv> tags
        const match = content.match(/<tv[^>]*>([\s\S]*)<\/tv>/);
        if (match && match[1]) {
          res.write(match[1]);
        }
      } catch (e) {
        console.error(`Error reading EPG file ${file}:`, e.message);
      }
    }
    
    res.write('</tv>');
    res.end();
  } catch (e) {
    console.error('xmltv error:', e.message);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
  }
});

// === DELETE APIs ===
app.delete('/api/providers/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(id);
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/user-categories/:id', (req, res) => {
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

app.delete('/api/user-channels/:id', (req, res) => {
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
    const cats = db.prepare('SELECT id FROM user_categories WHERE user_id = ?').all(id);
    for (const cat of cats) {
      db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(cat.id);
    }
    db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === Sync Config APIs ===
app.get('/api/sync-configs', (req, res) => {
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

app.get('/api/sync-configs/:providerId/:userId', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?')
      .get(Number(req.params.providerId), Number(req.params.userId));
    res.json(config || null);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/sync-configs', (req, res) => {
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

app.put('/api/sync-configs/:id', (req, res) => {
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

app.delete('/api/sync-configs/:id', (req, res) => {
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
app.get('/api/sync-logs', (req, res) => {
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
app.get('/api/category-mappings/:providerId/:userId', (req, res) => {
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

app.put('/api/category-mappings/:id', (req, res) => {
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
app.put('/api/user-categories/:id', (req, res) => {
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

app.put('/api/providers/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, url, username, password, epg_url } = req.body;
    if (!name || !url || !username || !password) {
      return res.status(400).json({error: 'missing fields'});
    }

    db.prepare(`
      UPDATE providers
      SET name = ?, url = ?, username = ?, password = ?, epg_url = ?
      WHERE id = ?
    `).run(name.trim(), url.trim(), username.trim(), password.trim(), (epg_url || '').trim(), id);
    
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.put('/api/user-categories/:id/adult', (req, res) => {
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
    fs.writeFileSync(cacheFile, epgData, 'utf8');
    
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
app.get('/api/epg-sources', (req, res) => {
  try {
    const sources = db.prepare('SELECT * FROM epg_sources ORDER BY name').all();
    
    // Add provider EPG sources
    const providers = db.prepare("SELECT id, name, epg_url FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
    const allSources = [
      ...providers.map(p => ({
        id: `provider_${p.id}`,
        name: `${p.name} (Provider EPG)`,
        url: p.epg_url,
        enabled: 1,
        last_update: 0,
        update_interval: 86400,
        source_type: 'provider',
        is_updating: 0
      })),
      ...sources
    ];
    
    res.json(allSources);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.post('/api/epg-sources', (req, res) => {
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

app.put('/api/epg-sources/:id', (req, res) => {
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

app.delete('/api/epg-sources/:id', (req, res) => {
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
app.post('/api/epg-sources/:id/update', async (req, res) => {
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
app.post('/api/epg-sources/update-all', async (req, res) => {
  try {
    const sources = db.prepare('SELECT id FROM epg_sources WHERE enabled = 1').all();
    const providers = db.prepare("SELECT id FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
    
    const results = [];
    
    // Update provider EPGs
    for (const provider of providers) {
      try {
        const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(provider.id);
        const response = await fetch(p.epg_url);
        if (response.ok) {
          const epgData = await response.text();
          const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
          fs.writeFileSync(cacheFile, epgData, 'utf8');
          results.push({id: `provider_${provider.id}`, success: true});
        }
      } catch (e) {
        results.push({id: `provider_${provider.id}`, success: false, error: e.message});
      }
    }
    
    // Update regular EPG sources
    for (const source of sources) {
      try {
        await updateEpgSource(source.id);
        results.push({id: source.id, success: true});
      } catch (e) {
        results.push({id: source.id, success: false, error: e.message});
      }
    }
    
    res.json({success: true, results});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Cache for EPG sources
let epgSourcesCache = null;
let epgSourcesCacheTime = 0;
const EPG_CACHE_DURATION = 3600000; // 1 hour

// Get available EPG sources from globetvapp/epg
app.get('/api/epg-sources/available', async (req, res) => {
  try {
    // Return cached data if available and fresh
    const now = Date.now();
    if (epgSourcesCache && (now - epgSourcesCacheTime) < EPG_CACHE_DURATION) {
      return res.json(epgSourcesCache);
    }
    
    console.log('📡 Fetching EPG sources via GitHub Tree API...');

    // 1. Get default branch
    const repoResponse = await fetch('https://api.github.com/repos/globetvapp/epg');
    const repoData = await repoResponse.json();
    
    if (repoData.message && repoData.message.includes('rate limit')) {
      console.warn('GitHub API rate limit reached (repo info), returning cached or empty data');
      return res.json(epgSourcesCache || []);
    }

    if (!repoResponse.ok) {
       throw new Error('Failed to fetch repo info');
    }

    const defaultBranch = repoData.default_branch || 'main';

    // 2. Fetch tree recursively
    const treeResponse = await fetch(`https://api.github.com/repos/globetvapp/epg/git/trees/${defaultBranch}?recursive=1`);
    const treeData = await treeResponse.json();

    if (treeData.message && treeData.message.includes('rate limit')) {
      console.warn('GitHub API rate limit reached (tree), returning cached or empty data');
      return res.json(epgSourcesCache || []);
    }

    if (!treeResponse.ok) {
      throw new Error('Failed to fetch tree');
    }

    const epgSources = [];
    const tree = treeData.tree || [];

    for (const item of tree) {
      // Filter for files, .xml, not .gz
      if (item.type === 'blob' && item.path.endsWith('.xml') && !item.path.endsWith('.xml.gz')) {
        const parts = item.path.split('/');
        // Ensure structure is Country/File.xml (depth 2)
        if (parts.length === 2) {
          const country = parts[0];
          const filename = parts[1];
          // Construct raw URL
          const downloadUrl = `https://raw.githubusercontent.com/globetvapp/epg/${defaultBranch}/${encodeURI(item.path)}`;

          epgSources.push({
            name: `${country} - ${filename.replace(/\.xml$/, '')}`,
            url: downloadUrl,
            size: item.size,
            country: country
          });
        }
      }
    }
    
    console.log(`✅ Found ${epgSources.length} EPG sources via Tree API`);
    
    // Cache the results
    if (epgSources.length > 0) {
      epgSourcesCache = epgSources;
      epgSourcesCacheTime = now;
    }
    
    res.json(epgSources);
  } catch (e) {
    console.error('EPG sources error:', e.message);
    // Return cached data if available, otherwise empty array
    res.json(epgSourcesCache || []);
  }
});

// Start
app.listen(PORT, () => {
  console.log(`✅ IPTV-Manager: http://localhost:${PORT}`);
});
