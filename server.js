import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import Database from 'better-sqlite3';
import { Xtream } from '@iptv/xtream-api';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

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
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_category_id INTEGER NOT NULL,
      provider_channel_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
  `);
  console.log("✅ Database OK");
} catch (e) {
  console.error("❌ DB Error:", e.message);
  process.exit(1);
}

// Xtream Client
function createXtreamClient(provider) {
  let baseUrl = (provider.url || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
  baseUrl = baseUrl.replace(/\/+$/, '');
  return new Xtream({ url: baseUrl, username: provider.username, password: provider.password });
}

// Auth
function authUser(username, password) {
  try {
    const u = (username || '').trim();
    const p = (password || '').trim();
    if (!u || !p) return null;
    return db.prepare('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1').get(u, p);
  } catch (e) {
    console.error('authUser error:', e);
    return null;
  }
}

// === API: Users ===
app.get('/api/users', (req, res) => {
  try {
    res.json(db.prepare('SELECT id, username, is_active FROM users ORDER BY id').all());
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.post('/api/users', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({error: 'missing'});
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username.trim(), password.trim());
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(400).json({error: e.message}); }
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
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!provider) return res.status(404).json({error: 'not found'});

    const xtream = createXtreamClient(provider);
    let channels = [];
    
    try { channels = await xtream.getChannels(); } catch {
      try { channels = await xtream.getLiveStreams(); } catch {
        const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_streams`;
        const resp = await fetch(apiUrl);
        channels = resp.ok ? await resp.json() : [];
      }
    }

    const insert = db.prepare(`
      INSERT OR REPLACE INTO provider_channels 
      (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const ch of (channels || [])) {
        const sid = Number(ch.stream_id || ch.id || 0);
        if (sid > 0) {
          insert.run(
            provider.id,
            sid,
            ch.name || 'Unknown',
            Number(ch.category_id || 0),
            ch.stream_icon || '',
            'live',
            ch.epg_channel_id || ''
          );
        }
      }
    })();

    res.json({synced: channels.length});
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

    const xtream = createXtreamClient(provider);
    let categories = [];
    
    try {
      // Direkt vom Provider abrufen
      const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_categories`;
      const resp = await fetch(apiUrl);
      if (resp.ok) {
        categories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }

    // Zusätzlich: Kategorien aus bereits synchronisierten Kanälen
    const localCats = db.prepare(`
      SELECT DISTINCT original_category_id, 
             GROUP_CONCAT(name) as sample_channels,
             COUNT(*) as channel_count
      FROM provider_channels 
      WHERE provider_id = ? AND original_category_id > 0
      GROUP BY original_category_id
      ORDER BY channel_count DESC
    `).all(id);

    // Merge: API-Kategorien mit lokalen Channel-Counts
    const merged = categories.map(cat => {
      const local = localCats.find(l => Number(l.original_category_id) === Number(cat.category_id));
      return {
        category_id: cat.category_id,
        category_name: cat.category_name,
        channel_count: local ? local.channel_count : 0
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

    // 1. User-Kategorie erstellen
    const catInfo = db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(user_id, category_name);
    const newCategoryId = catInfo.lastInsertRowid;

    // 2. Optional: Kanäle automatisch zuordnen
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
        channels_imported: channels.length
      });
    } else {
      res.json({
        success: true, 
        category_id: newCategoryId,
        channels_imported: 0
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
    const info = db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)').run(Number(req.params.userId), name.trim());
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
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
    const { provider_channel_id } = req.body;
    if (!provider_channel_id) return res.status(400).json({error: 'channel required'});
    const info = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (?, ?)').run(Number(req.params.catId), Number(provider_channel_id));
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// === Xtream API ===
app.get('/player_api.php', (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const action = (req.query.action || '').trim();

    const user = authUser(username, password);
    if (!user) {
      // Auth failed
      return res.json({user_info: {auth: 0, message: 'Invalid credentials'}});
    }

    const now = Math.floor(Date.now() / 1000);

    // KEIN ACTION = Server Info
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

    // get_live_categories = DIREKTES ARRAY (kein wrapper!)
    if (action === 'get_live_categories') {
      const cats = db.prepare('SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order').all(user.id);
      const result = cats.map(c => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }));
      return res.json(result);  // ← Direktes Array!
    }

    // get_live_streams = DIREKTES ARRAY (kein wrapper!)
    if (action === 'get_live_streams') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.*
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ?
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = rows.map((ch, i) => ({
        num: i + 1,
        name: ch.name,
        stream_type: 'live',
        stream_id: Number(ch.user_channel_id),
        stream_icon: ch.logo || '',
        epg_channel_id: ch.epg_channel_id || '',
        added: now.toString(),
        is_adult: 0,
        category_id: String(ch.user_category_id),
        category_ids: [Number(ch.user_category_id)],  // ← Zusätzlich als Array!
        custom_sid: null,
        tv_archive: 0,
        direct_source: '',
        tv_archive_duration: 0
      }));
      return res.json(result);  // ← Direktes Array!
    }

    // VOD/Series = leere Arrays
    if (['get_vod_categories', 'get_series_categories', 'get_vod_streams', 'get_series'].includes(action)) {
      return res.json([]);  // ← Direktes leeres Array!
    }

    // Unbekannte Action
    res.status(400).json([]);

  } catch (e) {
    console.error('player_api error:', e);
    res.status(500).json([]);
  }
});

// === Stream Proxy (CRASH-FIX) ===
app.get('/live/:username/:password/:stream_id.ts', async (req, res) => {
  try {
    const username = (req.params.username || '').trim();
    const password = (req.params.password || '').trim();
    const streamId = Number(req.params.stream_id || 0);

    if (!streamId) return res.sendStatus(404);

    const user = authUser(username, password);
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

    console.log('Proxy:', remoteUrl);

    const upstream = await fetch(remoteUrl);
    if (!upstream.ok || !upstream.body) return res.sendStatus(502);

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Connection', 'keep-alive');
    upstream.body.pipe(res);

  } catch (e) {
    console.error('Stream proxy error:', e);
    res.sendStatus(500);
  }
});

// === XMLTV (CRASH-FIX) ===
app.get('/xmltv.php', async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    
    const user = authUser(username, password);
    if (!user) return res.sendStatus(401);

    // FIX: Sichere Abfrage mit COALESCE
    const provider = db.prepare(`
      SELECT * FROM providers 
      WHERE COALESCE(epg_url, '') != '' 
      LIMIT 1
    `).get();

    if (!provider || !provider.epg_url) {
      return res.status(404).send('<!-- No EPG configured -->');
    }

    const upstream = await fetch(provider.epg_url);
    if (!upstream.ok || !upstream.body) return res.sendStatus(502);

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    upstream.body.pipe(res);
    
  } catch (e) {
    console.error('xmltv error:', e.message);
    res.status(500).send('<!-- EPG error -->');
  }
});

// === DELETE APIs ===

// Provider löschen
app.delete('/api/providers/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    // Erst alle Kanäle des Providers löschen
    db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(id);
    // Dann Provider selbst
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Kategorie löschen
app.delete('/api/user-categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    // Erst alle Kanäle in der Kategorie löschen
    db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(id);
    // Dann Kategorie
    db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Kanal aus Kategorie entfernen
app.delete('/api/user-channels/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM user_channels WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// User löschen
app.delete('/api/users/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    // Alle User-Daten löschen
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

// === UPDATE APIs ===

// Kategorie umbenennen
app.put('/api/user-categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});
    db.prepare('UPDATE user_categories SET name = ? WHERE id = ?').run(name.trim(), id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Provider bearbeiten
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


// Start
app.listen(PORT, () => {
  console.log(`✅ IPTV Meta Panel: http://localhost:${PORT}`);
});
