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
      return res.status(403).send('Access denied (unsafe URL)');
    }

    const response = await fetch(url, {
        headers: { 'User-Agent': 'IPTV-Manager/1.0' }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
       return res.status(400).send('URL is not an image');
    }

    res.setHeader('Content-Type', contentType);
    // Cache control to reduce load
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day

    response.body.pipe(res);

  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).send('Internal Server Error');
  }
});

export default router;
