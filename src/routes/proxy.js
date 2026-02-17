import express from 'express';
import fetch from 'node-fetch';
import http from 'http';
import https from 'https';
import { isSafeUrl, safeLookup } from '../utils/helpers.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

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
    // 1. Fetch Image with Safe Handling (SSRF + Redirect Protection)
    const response = await fetchSafe(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
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

    if (error.message.includes('unsafe IP') || error.message.includes('Unsafe URL')) {
      return res.status(403).send('Access denied (Unsafe URL or DNS Rebinding detected)');
    }

    if (error.code === 'EHOSTUNREACH' || error.code === 'ECONNREFUSED') {
      return res.status(502).send('Bad Gateway (Upstream Unreachable)');
    }

    if (error.code === 'ETIMEDOUT') {
      return res.status(504).send('Gateway Timeout');
    }

    if (error.message === 'Too many redirects') {
      return res.status(502).send('Bad Gateway (Too many redirects)');
    }

    res.status(500).send('Internal Server Error');
  }
});

export default router;
