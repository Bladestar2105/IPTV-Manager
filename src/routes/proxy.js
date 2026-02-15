import express from 'express';
import fetch from 'node-fetch';
import { isSafeUrl } from '../utils/helpers.js';

const router = express.Router();

router.get('/image', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send('URL is required');
  }

  try {
    // 1. SSRF Protection
    if (!(await isSafeUrl(url))) {
      console.warn(`[Proxy] Blocked unsafe URL: ${url}`);
      return res.status(403).send('Access denied (unsafe URL)');
    }

    // 2. Fetch Image
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
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
    if (contentType.match(/^image\//i) || contentType.toLowerCase() === 'application/octet-stream') {
        res.setHeader('Content-Type', contentType);
    } else {
        // Force safe type for unknown or dangerous types (text/html, text/javascript, etc.)
        res.setHeader('Content-Type', 'application/octet-stream');
    }

    // Cache control
    const cacheControl = response.headers.get('cache-control');
    if (cacheControl) {
        res.setHeader('Cache-Control', cacheControl);
    } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    response.body.pipe(res);

  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

export default router;
