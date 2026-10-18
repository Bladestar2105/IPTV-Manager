import express from 'express';
import crypto from 'node:crypto';
import db from '../database/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { fetchSafe, discardBody, readBodyWithLimit } from '../utils/network.js';
import { getXtreamUser } from '../services/authService.js';
import { getLogoCacheHash, registerProviderCachedIcon } from '../services/logoResolver.js';
import { getCachedImage, clearImageCache, imageRequestHeaders } from '../services/imageCacheService.js';
import { createClientResourceUrl, resolveClientResource, rewriteClientMetadata } from '../services/clientResourceService.js';
import { isClientManifest, rewriteHlsManifest, rewriteDashManifest } from '../utils/clientManifests.js';
import { createUpstreamContext, upstreamRequestHeaders, withUpstreamCookies } from '../utils/clientCookies.js';
import { reserveGrantedResourceSession } from '../controllers/streamControllerHelpers.js';
import { validateClientTtml } from '../utils/clientTtml.js';

const router = express.Router();
const MANIFEST_LIMIT = 32 * 1024 * 1024;

async function authenticateAnyToken(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    const credentialLogin = typeof req.query.username === 'string' && typeof req.query.password === 'string';
    if (!token && !credentialLogin) return res.status(401).json({ error: 'No token provided' });
    const user = await getXtreamUser(req);
    if (user) {
      if (!credentialLogin && !user.is_admin && !user.is_share_guest && user.webui_access === 0) return res.status(403).json({ error: 'WebUI access revoked' });
      req.user = user;
      return next();
    }
    return authenticateToken(req, res, next);
  } catch {
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

function protectResource(res) {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function sendImage(res, url, headers, providerId, response, cookieContext = {}) {
  const image = await getCachedImage(url, { headers, response, cookieJar: cookieContext.cookieJar, headerOrigin: cookieContext.headerOrigin });
  protectResource(res);
  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
  res.setHeader('X-Cache', image.cacheStatus);
  if (image.cacheStatus === 'STALE') res.setHeader('Warning', '110 - "Upstream image unavailable; cached image served"');
  if (providerId) registerProviderCachedIcon(providerId, url, getLogoCacheHash(url));
  return res.send(image.body);
}

router.get('/image', authenticateAnyToken, async (req, res) => {
  if (typeof req.query.url !== 'string' || !/^https?:\/\//i.test(req.query.url)) return res.status(400).send('URL is required');
  try {
    await sendImage(res, req.query.url, {}, Number(req.query.provider_id) || null);
  } catch {
    if (!res.headersSent) res.status(502).send('Image unavailable');
  }
});

router.all('/resource/:data/:filename', async (req, res) => {
  const resource = req.clientResource === undefined ? await resolveClientResource(req) : req.clientResource;
  if (!resource) return res.sendStatus(401);
  if (!['GET', 'HEAD'].includes(req.method) && !(resource.kind === 'license' && req.method === 'POST')) {
    res.setHeader('Allow', resource.kind === 'license' ? 'GET, HEAD, POST' : 'GET, HEAD');
    return res.sendStatus(405);
  }
  let upstream;
  let cleanup = () => {};
  let heartbeat;
  const controller = new AbortController();
  res.once('close', () => { controller.abort(); discardBody(upstream); cleanup(); });
  try {
    const cookieContext = createUpstreamContext(resource.headers, resource.headerOrigin || resource.url, resource.cookieJar, resource.headerOrigin || resource.url);
    const scopedHeaders = upstreamRequestHeaders(cookieContext, resource.url);
    if (resource.kind === 'image') return await sendImage(res, resource.url, scopedHeaders, resource.providerId, undefined, cookieContext);

    if (resource.channelName && resource.providerId && resource.kind === 'resource') {
      const { default: manager } = await import('../services/streamManager.js');
      const id = crypto.randomUUID();
      let registered = false;
      cleanup = () => { if (registered) { registered = false; manager.localStreams.delete(id); manager.remove(id); } };
      if (!await reserveGrantedResourceSession(id, resource.user, resource.channelId, resource.providerId, req, res, resource.channelName)) return;
      registered = true;
      if (controller.signal.aborted) { cleanup(); return; }
      manager.localStreams.set(id, { destroy: () => { controller.abort(); discardBody(upstream); res.destroy(); cleanup(); } });
      heartbeat = () => manager.touch(id);
    }

    const headers = resource.kind === 'resource' ? imageRequestHeaders(scopedHeaders) : { ...scopedHeaders };
    for (const name of ['range', 'if-range']) if (req.headers[name]) headers[name] = req.headers[name];
    if (resource.kind === 'license' && req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    upstream = await fetchSafe(resource.url, {
      method: req.method === 'HEAD' ? 'GET' : req.method,
      headers,
      cookieJar: cookieContext.cookieJar,
      headerOrigin: cookieContext.headerOrigin,
      signal: controller.signal,
      ...(req.method === 'POST' ? { body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) } : {}),
    });
    if (!upstream.ok || (upstream.status >= 300 && upstream.status < 400)) {
      discardBody(upstream);
      return res.sendStatus(502);
    }
    protectResource(res);
    res.setHeader('Cache-Control', 'private, no-store');
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const baseUrl = upstream.url || resource.url;
    const manifest = resource.kind === 'license' ? null : resource.manifestKind || isClientManifest(type, baseUrl);
    const nextContext = withUpstreamCookies(cookieContext.headers, upstream, resource.url, cookieContext.cookieJar, cookieContext.headerOrigin);
    delete nextContext.headers.Range;
    delete nextContext.headers.range;
    const map = (url, options = {}) => createClientResourceUrl(req, resource.user, url, {
      kind: 'resource', ...nextContext, channelId: resource.channelId,
      channelName: resource.channelName, providerId: resource.providerId, ...options,
    });
    // Descendants retain the original share/session constraint, not merely the owner ID.
    if (resource.sourceToken) resource.user = { ...resource.user, resource_token: resource.sourceToken };
    if (manifest) {
      const text = await readBodyWithLimit(upstream, { maxBytes: MANIFEST_LIMIT, timeoutMs: 30000 });
      const rewritten = manifest === 'hls'
        ? rewriteHlsManifest(text, baseUrl, map, resource.hlsVariables)
        : rewriteDashManifest(text, baseUrl, map);
      res.setHeader('Content-Type', manifest === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml');
      return res.send(rewritten);
    }
    if (resource.kind !== 'license' && /^image\//i.test(type)) {
      return await sendImage(res, resource.url, scopedHeaders, resource.providerId, upstream, cookieContext);
    }
    if (resource.kind !== 'license' && /^application\/ttml\+xml(?:\s*;|$)/i.test(type)) {
      const text = await readBodyWithLimit(upstream, { maxBytes: 4 * 1024 * 1024, timeoutMs: 30000 });
      res.setHeader('Content-Type', 'application/ttml+xml; charset=utf-8');
      return res.send(validateClientTtml(text));
    }
    // Unknown active document formats could contain dependencies we cannot
    // rewrite safely. Never delegate their network access to the client.
    if (resource.kind !== 'license' && /(?:html|xml|text\/css)/i.test(type)) {
      discardBody(upstream);
      return res.sendStatus(502);
    }
    if (resource.kind !== 'license' && /application\/(?:[^;]+\+)?json/i.test(type)) {
      const data = await readBodyWithLimit(upstream, { as: 'json', maxBytes: MANIFEST_LIMIT, timeoutMs: 30000 });
      return res.json(rewriteClientMetadata(req, resource.user, data, '', {
        baseUrl,
        channelId: resource.channelId, channelName: resource.channelName,
        providerId: resource.providerId, ...nextContext,
      }));
    }
    if (resource.kind === 'license') {
      const body = await readBodyWithLimit(upstream, { as: 'buffer', maxBytes: 8 * 1024 * 1024, timeoutMs: 30000 });
      res.setHeader('Content-Type', type);
      return res.send(body);
    }
    res.status(upstream.status);
    res.setHeader('Content-Type', type);
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      // node-fetch decodes compressed bodies while retaining upstream headers.
      if (name === 'content-length' && /^(?:gzip|deflate|br)$/i.test(upstream.headers.get('content-encoding') || '')) continue;
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (req.method === 'HEAD') { discardBody(upstream); return res.end(); }
    if (heartbeat) upstream.body.on('data', heartbeat);
    upstream.body.once('error', () => { cleanup(); res.destroy(); });
    upstream.body.once('end', cleanup);
    return upstream.body.pipe(res);
  } catch {
    discardBody(upstream);
    cleanup();
    if (!res.headersSent) res.status(502).send('Resource unavailable');
    else res.destroy();
  }
});

router.delete('/picons', authenticateToken, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Access denied' });
  try {
    const deleted = await clearImageCache();
    try { db.exec('DELETE FROM provider_icon_cache'); } catch { /* Tracking does not affect image delivery. */ }
    return res.json({ deleted });
  } catch {
    return res.status(500).json({ error: 'Failed to prune cache' });
  }
});

export default router;
