import crypto from 'crypto';
import db from '../database/db.js';
import { getBaseUrl } from '../utils/helpers.js';

function generateSlug(name) {
    return name.toString().toLowerCase()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start
        .replace(/-+$/, '');            // Trim - from end
}

export const createShare = (req, res) => {
  try {
    const { channels, name, start_time, end_time, create_slug } = req.body;
    let user_id = req.user.id;

    if (req.user.is_admin && req.body.user_id) {
        user_id = req.body.user_id;
    }

    if (!channels || !Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: 'Channels array required' });
    }

    const token = crypto.randomUUID();
    const startTime = start_time ? Math.floor(new Date(start_time).getTime() / 1000) : null;
    const endTime = end_time ? Math.floor(new Date(end_time).getTime() / 1000) : null;

    let slug = null;
    if (create_slug && name) {
        let baseSlug = generateSlug(name);
        if (!baseSlug) baseSlug = 'share';

        slug = baseSlug;
        let counter = 1;
        while (true) {
            const existing = db.prepare('SELECT token FROM shared_links WHERE slug = ?').get(slug);
            if (!existing) break;
            slug = `${baseSlug}-${counter}`;
            counter++;
        }
    }

    db.prepare(`
      INSERT INTO shared_links (token, user_id, name, channels, start_time, end_time, slug)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(token, user_id, name || 'Shared Link', JSON.stringify(channels), startTime, endTime, slug);

    const baseUrl = getBaseUrl(req);
    const link = `${baseUrl}/player.html?token=${encodeURIComponent(token)}`;
    const shortLink = slug ? `${baseUrl}/share/${slug}` : null;

    res.json({ success: true, token, link, short_link: shortLink, slug });
  } catch (e) {
    console.error('Create share error:', e);
    res.status(500).json({ error: e.message });
  }
};

export const updateShare = (req, res) => {
  try {
    const token = req.params.token;
    const { channels, name, start_time, end_time } = req.body;

    const startTime = start_time ? Math.floor(new Date(start_time).getTime() / 1000) : null;
    const endTime = end_time ? Math.floor(new Date(end_time).getTime() / 1000) : null;

    if (!channels || !Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: 'Channels array required' });
    }

    // Note: We don't currently support updating the slug to avoid breaking existing links
    // If user wants a new slug, they can recreate the share.

    let info;
    if (req.user.is_admin) {
        info = db.prepare('UPDATE shared_links SET channels = ?, name = ?, start_time = ?, end_time = ? WHERE token = ?')
                 .run(JSON.stringify(channels), name || 'Shared Link', startTime, endTime, token);
    } else {
        info = db.prepare('UPDATE shared_links SET channels = ?, name = ?, start_time = ?, end_time = ? WHERE token = ? AND user_id = ?')
                 .run(JSON.stringify(channels), name || 'Shared Link', startTime, endTime, token, req.user.id);
    }

    if (info.changes === 0) return res.status(404).json({ error: 'Share not found' });

    res.json({ success: true, token });
  } catch (e) {
    console.error('Update share error:', e);
    res.status(500).json({ error: e.message });
  }
};

export const deleteShare = (req, res) => {
  try {
    const token = req.params.token;

    let info;
    if (req.user.is_admin) {
        info = db.prepare('DELETE FROM shared_links WHERE token = ?').run(token);
    } else {
        info = db.prepare('DELETE FROM shared_links WHERE token = ? AND user_id = ?').run(token, req.user.id);
    }

    if (info.changes === 0) return res.status(404).json({ error: 'Share not found' });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const getShares = (req, res) => {
  try {
    let user_id = req.user.id;
    if (req.user.is_admin && req.query.user_id) {
        user_id = req.query.user_id;
    }

    const shares = db.prepare('SELECT * FROM shared_links WHERE user_id = ? ORDER BY created_at DESC').all(user_id);

    const baseUrl = getBaseUrl(req);
    const result = shares.map(s => {
        let count = 0;
        try { count = JSON.parse(s.channels).length; } catch(e) {}
        return {
            ...s,
            link: `${baseUrl}/player.html?token=${encodeURIComponent(s.token)}`,
            short_link: s.slug ? `${baseUrl}/share/${s.slug}` : null,
            channel_count: count
        };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const handleShortLink = (req, res) => {
    try {
        const slug = req.params.slug;
        if (!slug) return res.status(404).send('Not Found');

        const share = db.prepare('SELECT token FROM shared_links WHERE slug = ?').get(slug);

        if (!share) {
            return res.status(404).send('Share link not found or expired');
        }

        const baseUrl = getBaseUrl(req);
        res.redirect(`${baseUrl}/player.html?token=${encodeURIComponent(share.token)}`);
    } catch (e) {
        console.error('Short link error:', e);
        res.status(500).send('Internal Server Error');
    }
};
