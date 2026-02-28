import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { PassThrough, Transform } from 'stream';
import { authenticateToken } from '../middleware/auth.js';
import { CACHE_DIR } from '../config/constants.js';
import { fetchSafe } from '../utils/network.js';
import { getXtreamUser } from '../services/authService.js';

const router = express.Router();

// Middleware to support both WebUI JWT token and Player temporary token
async function authenticateAnyToken(req, res, next) {
    try {
        // First try the standard WebUI token via the existing middleware
        // But we don't want it to send an error response if it fails, so we wrap it
        const authHeader = req.headers['authorization'];
        let token = authHeader && authHeader.split(' ')[1];
        if (!token && req.query.token) {
            token = req.query.token;
        }

        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        // Try using getXtreamUser which resolves player tokens, shared links, etc.
        const user = await getXtreamUser(req);
        if (user) {
            // Check WebUI Access for normal users (only if not a share guest)
            if (!user.is_admin && !user.is_share_guest && user.webui_access === 0) {
                 return res.status(403).json({ error: 'WebUI access revoked' });
            }
            req.user = user;
            return next();
        }

        // If not found via getXtreamUser, fallback to standard authenticateToken
        authenticateToken(req, res, next);
    } catch (e) {
        console.error('authenticateAnyToken Error:', e);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

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

router.get('/image', authenticateAnyToken, async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send('URL is required');
  }

  try {
    // Generate Hash for Filename
    const hash = crypto.createHash('md5').update(url).digest('hex');
    const filePath = path.join(PICON_CACHE_DIR, `${hash}.png`); // Default to png or detect extension?

    // Check Cache
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      // Serve from Cache
      res.setHeader('X-Cache', 'HIT');
      // Try to determine content type from file extension or just default to image/png
      // Since we save everything as .png (or just use hash without ext and rely on content-type detection?)
      // Actually, saving with extension helps OS/browsers.
      // Let's check if we can store metadata or just trust it's an image.
      res.setHeader('Content-Type', 'image/png'); // Simplified
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(filePath).pipe(res);
      return;
    } catch (e) {
      // File does not exist, proceed to fetch
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

    // Limit and Buffer
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB limit
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
        return res.status(413).send('Image too large');
    }

    const tempPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const fileStream = fs.createWriteStream(tempPath);
    const multiplexer = new PassThrough();
    let cacheError = false;
    let received = 0;

    // 1. Setup error handling and piping for multiplexer destinations
    fileStream.on('error', (err) => {
        console.error('Cache write error:', err);
        cacheError = true;
        multiplexer.unpipe(fileStream);
        fileStream.destroy();
    });

    res.on('error', (err) => {
        console.error('Response stream error:', err);
        multiplexer.unpipe(res);
    });

    res.on('close', () => {
        multiplexer.unpipe(res);
    });

    multiplexer.pipe(res);
    multiplexer.pipe(fileStream);

    // 2. Setup Size Checker
    const sizeChecker = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length;
            if (received > MAX_SIZE) {
                callback(new Error('Image too large'));
                return;
            }
            callback(null, chunk);
        }
    });

    // 3. Prepare Response Headers
    if (contentLength) {
        res.setHeader('Content-Length', contentLength);
    }
    res.setHeader('X-Cache', 'MISS');

    // 4. Run Pipeline
    try {
        await pipeline(
            response.body,
            sizeChecker,
            multiplexer
        );

        // Success: Rename cache file if no cache error occurred
        if (!cacheError && !fileStream.destroyed) {
            // Wait for fileStream to fully flush
            await new Promise((resolve) => {
                if (fileStream.writableEnded) resolve();
                else fileStream.on('finish', resolve);
            });
            await fs.promises.rename(tempPath, filePath);
        }
    } catch (err) {
        // Clean up on error
        if (fileStream) fileStream.destroy();

        if (err.message === 'Image too large') {
            if (!res.headersSent) {
                return res.status(413).send('Image too large');
            } else {
                return res.destroy(); // Truncate response
            }
        }
        throw err; // Re-throw for general error handler
    } finally {
        // Final cleanup of temp file if it still exists and wasn't renamed
        try {
            if (fs.existsSync(tempPath)) {
                await fs.promises.unlink(tempPath);
            }
        } catch (e) {}
    }

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

    if (error.message === 'Image too large') {
        return res.status(413).send('Image too large');
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
        let files;
        try {
            files = await fs.promises.readdir(PICON_CACHE_DIR);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return res.json({ deleted: 0 });
            }
            throw err;
        }

        await Promise.all(files.map(file => fs.promises.unlink(path.join(PICON_CACHE_DIR, file))));

        res.json({ deleted: files.length });
    } catch (error) {
        console.error('Failed to prune cache:', error);
        res.status(500).json({ error: 'Failed to prune cache' });
    }
});

export default router;
