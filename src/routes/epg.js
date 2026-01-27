import express from 'express';
import db from '../config/database.js';
import { updateEpgSource } from '../services/epgService.js';
import { EPG_CACHE_DIR, ROOT_DIR } from '../config/paths.js';
import path from 'path';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth.js';
import fetch from 'node-fetch';

const router = express.Router();

// === EPG Sources APIs ===
router.get('/epg-sources', (req, res) => {
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

router.post('/epg-sources', (req, res) => {
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

router.put('/epg-sources/:id', (req, res) => {
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

router.delete('/epg-sources/:id', (req, res) => {
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
router.post('/epg-sources/:id/update', async (req, res) => {
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
router.post('/epg-sources/update-all', async (req, res) => {
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

// Get available EPG sources from static JSON file
router.get('/epg-sources/available', (req, res) => {
  try {
    const epgSourcesPath = path.join(ROOT_DIR, 'epg_sources.json');

    // Check if the file exists
    if (!fs.existsSync(epgSourcesPath)) {
      console.warn('⚠️  epg_sources.json not found, returning empty array');
      return res.json([]);
    }

    // Read and parse the file
    const data = fs.readFileSync(epgSourcesPath, 'utf8');
    const epgData = JSON.parse(data);

    console.log(`📦 Returning ${epgData.epg_sources.length} EPG sources from static file`);
    res.json(epgData.epg_sources);
  } catch (e) {
    console.error('EPG sources error:', e.message);
    res.json([]);
  }
});

// === EPG Mapping API ===

// Get all EPG mappings for a user
router.get('/users/:userId/epg-mappings', authenticateToken, (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const rows = db.prepare(`
      SELECT
        em.id,
        em.user_channel_id,
        em.epg_channel_id,
        em.mapping_type,
        em.created_at,
        em.updated_at,
        uc.user_category_id,
        pc.name as channel_name,
        pc.logo as channel_logo
      FROM epg_mappings em
      JOIN user_channels uc ON uc.id = em.user_channel_id
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE cat.user_id = ?
    `).all(userId);

    res.json(rows);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Get unmapped channels for a user
router.get('/users/:userId/epg-mappings/unmapped', authenticateToken, (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const rows = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.name as channel_name,
        pc.logo as channel_logo,
        uc.user_category_id,
        cat.name as category_name
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE cat.user_id = ?
      AND uc.id NOT IN (SELECT user_channel_id FROM epg_mappings)
    `).all(userId);

    res.json(rows);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Get available EPG channels from cached EPG data
router.get('/epg-mappings/available-channels', authenticateToken, (req, res) => {
  try {
    const { search } = req.query;

    // Read all EPG XML files from cache

    if (!fs.existsSync(EPG_CACHE_DIR)) {
      return res.json([]);
    }

    const epgChannels = new Map();

    // Iterate through all cached EPG files
    const files = fs.readdirSync(EPG_CACHE_DIR).filter(f => f.endsWith('.xml'));

    files.forEach(file => {
      const filePath = path.join(EPG_CACHE_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');

      // Simple XML parsing to extract channel IDs and names
      const channelRegex = /<channel[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
      let match;

      while ((match = channelRegex.exec(content)) !== null) {
        const channelId = match[1];
        const channelContent = match[2];

        // Extract display-name
        const nameRegex = /<display-name[^>]*>([^<]+)<\/display-name>/;
        const nameMatch = nameRegex.exec(channelContent);
        const channelName = nameMatch ? nameMatch[1] : channelId;

        // Store channel info
        if (!epgChannels.has(channelId)) {
          epgChannels.set(channelId, {
            id: channelId,
            name: channelName
          });
        }
      }
    });

    // Convert to array and filter by search term if provided
    let channels = Array.from(epgChannels.values());

    if (search) {
      const searchLower = search.toLowerCase();
      channels = channels.filter(ch =>
        ch.name.toLowerCase().includes(searchLower) ||
        ch.id.toLowerCase().includes(searchLower)
      );
    }

    // Limit results to avoid overwhelming the UI
    res.json(channels.slice(0, 100));
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Perform automatic EPG mapping
router.post('/users/:userId/epg-mappings/auto-map', authenticateToken, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const { strict = false } = req.body;

    // Get unmapped channels
    const unmappedChannels = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.name as channel_name
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE cat.user_id = ?
      AND uc.id NOT IN (SELECT user_channel_id FROM epg_mappings)
    `).all(userId);

    // Get available EPG channels
    const epgChannels = new Map();

    if (fs.existsSync(EPG_CACHE_DIR)) {
      const files = fs.readdirSync(EPG_CACHE_DIR).filter(f => f.endsWith('.xml'));

      files.forEach(file => {
        const filePath = path.join(EPG_CACHE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');

        const channelRegex = /<channel[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
        let match;

        while ((match = channelRegex.exec(content)) !== null) {
          const channelId = match[1];
          const channelContent = match[2];
          const nameRegex = /<display-name[^>]*>([^<]+)<\/display-name>/;
          const nameMatch = nameRegex.exec(channelContent);
          const channelName = nameMatch ? nameMatch[1] : channelId;

          if (!epgChannels.has(channelName.toLowerCase())) {
            epgChannels.set(channelName.toLowerCase(), channelId);
          }
        }
      });
    }

    // Perform matching
    let mappedCount = 0;
    const insertMapping = db.prepare(`
      INSERT INTO epg_mappings (user_channel_id, epg_channel_id, mapping_type)
      VALUES (?, ?, 'auto')
    `);

    unmappedChannels.forEach(channel => {
      const channelNameLower = channel.channel_name.toLowerCase();

      // Direct match
      if (epgChannels.has(channelNameLower)) {
        insertMapping.run(channel.user_channel_id, epgChannels.get(channelNameLower));
        mappedCount++;
        return;
      }

      // Fuzzy match if not strict mode
      if (!strict) {
        // Remove common variations
        const cleanedName = channelNameLower
          .replace(/\s*hd\s*$/i, '')
          .replace(/\s*4k\s*$/i, '')
          .replace(/\s*fhd\s*$/i, '')
          .replace(/\s*sd\s*$/i, '')
          .replace(/[^a-z0-9]/g, '');

        for (const [epgName, epgId] of epgChannels.entries()) {
          const cleanedEpgName = epgName
            .replace(/\s*hd\s*$/i, '')
            .replace(/\s*4k\s*$/i, '')
            .replace(/\s*fhd\s*$/i, '')
            .replace(/\s*sd\s*$/i, '')
            .replace(/[^a-z0-9]/g, '');

          if (cleanedName === cleanedEpgName) {
            insertMapping.run(channel.user_channel_id, epgId);
            mappedCount++;
            break;
          }
        }
      }
    });

    res.json({
      success: true,
      mapped_count: mappedCount,
      total_channels: unmappedChannels.length
    });
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Create manual EPG mapping
router.post('/epg-mappings', authenticateToken, (req, res) => {
  try {
    const { user_channel_id, epg_channel_id } = req.body;

    if (!user_channel_id || !epg_channel_id) {
      return res.status(400).json({error: 'user_channel_id and epg_channel_id required'});
    }

    const result = db.prepare(`
      INSERT INTO epg_mappings (user_channel_id, epg_channel_id, mapping_type)
      VALUES (?, ?, 'manual')
    `).run(user_channel_id, epg_channel_id);

    res.json({
      id: result.lastInsertRowid,
      user_channel_id,
      epg_channel_id
    });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({error: 'Mapping already exists'});
    }
    res.status(500).json({error: e.message});
  }
});

// Delete EPG mapping
router.delete('/epg-mappings/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM epg_mappings WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

export default router;
