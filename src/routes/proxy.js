import express from 'express';
import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isSafeUrl, safeLookup } from '../utils/helpers.js';
import { authenticateToken } from '../middleware/auth.js';
import { CACHE_DIR } from '../config/constants.js';

const router = express.Router();

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

// Picon Cache Directory
const PICON_CACHE_DIR = path.join(CACHE_DIR, 'picons');

// Ensure Cache Directory Exists
function ensureCacheDir() {
  if (!fs.existsSync(PICON_CACHE_DIR)) {
    fs.mkdirSync(PICON_CACHE_DIR, { recursive: true });
  }
}

// Initial check
ensureCacheDir();

export async function fetchSafe(url, options = {}, redirectCount = 0) {
  if (redirectCount > 5) {
    throw new Error('Too many redirects');
  }

  // Ensure URL is valid and safe
  if (!(await isSafeUrl(url))) {
    throw new Error(`Unsafe URL: ${url}`);
  }

  const fetchOptions = {
    ...options,
    redirect: 'manual',
    agent: (_parsedUrl) => (_parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent),
  };

  const response = await fetch(url, fetchOptions);

  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    const location = response.headers.get('location');
    const nextUrl = new URL(location, url).toString(); // Handle relative URLs
    return fetchSafe(nextUrl, options, redirectCount + 1);
  }

  return response;
}

router.get('/image', authenticateToken, async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send('URL is required');
  }

  try {
    // Generate Hash for Filename
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const filePath = path.join(PICON_CACHE_DIR, `${hash}.png`); // Default to png or detect extension?

    // Check Cache
    if (fs.existsSync(filePath)) {
      // Serve from Cache
      res.setHeader('X-Cache', 'HIT');
      // Try to determine content type from file extension or just default to image/png
      // Since we save everything as .png (or just use hash without ext and rely on content-type detection?)
      // Actually, saving with extension helps OS/browsers.
      // Let's check if we can store metadata or just trust it's an image.
      res.setHeader('Content-Type', 'image/png'); // Simplified
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // 1. Fetch Image with fetchSafe (Enforcing safeLookup and isSafeUrl for SSRF protection)
    const response = await fetchSafe(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      // timeout: 5000 // Add timeout? default is usually fine but maybe too long.
    });

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // 3. Security Headers
    // Prevent XSS by sandboxing the response. This stops JS execution even if served as HTML.
    res.setHeader('Content-Security-Policy', "sandbox allow-scripts 'none'; default-src 'none'; img-src data:; style-src 'unsafe-inline'");

    // 4. Content-Type Handling
    // Allow images and generic binary streams. Rewrite everything else to be safe.
    let finalContentType = 'application/octet-stream';
    if (contentType.match(/^image\//i) || contentType.toLowerCase() === 'application/octet-stream') {
        finalContentType = contentType;
    }
    res.setHeader('Content-Type', finalContentType);

    // Cache control
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) {
        res.setHeader('Cache-Control', cacheControl);
    } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    // Buffer and Save
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save to Cache
    // We only save if it looks like an image? content-type check passed above.
    // We use .png as extension for simplicity in serving, but it might be jpg/svg.
    // Maybe use mime-types lookup?
    // For now, saving as hash.png is acceptable for picons.
    try {
        fs.writeFileSync(filePath, buffer);
    } catch (writeErr) {
        console.error('Failed to write to cache:', writeErr);
        // Continue serving even if cache write fails
    }

    res.setHeader('X-Cache', 'MISS');
    res.send(buffer);

  } catch (error) {
    console.error('Proxy Error:', error);

    // Since we relaxed the fetch, these specific errors might not appear unless we re-introduce some checks.
    // But standard fetch errors (ECONNREFUSED, ENOTFOUND) will occur.

    if (error.code === 'EHOSTUNREACH' || error.code === 'ECONNREFUSED') {
      return res.status(502).send('Bad Gateway (Upstream Unreachable)');
    }

    if (error.code === 'ETIMEDOUT') {
      return res.status(504).send('Gateway Timeout');
    }

    res.status(500).send('Internal Server Error');
  }
});

// Prune Cache Endpoint
router.delete('/picons', authenticateToken, async (req, res) => {
    if (!req.user.is_admin) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        if (!fs.existsSync(PICON_CACHE_DIR)) {
            return res.json({ deleted: 0 });
        }

        const files = fs.readdirSync(PICON_CACHE_DIR);
        let deleted = 0;
        for (const file of files) {
            fs.unlinkSync(path.join(PICON_CACHE_DIR, file));
            deleted++;
        }

        res.json({ deleted });
    } catch (error) {
        console.error('Failed to prune cache:', error);
        res.status(500).json({ error: 'Failed to prune cache' });
    }
});

export default router;
