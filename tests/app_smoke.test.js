import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('application wiring smoke checks', () => {
  it('keeps all route modules mounted in the Express app', () => {
    const appSource = readRepoFile('src/app.js');

    [
      "app.use('/api', authRoutes)",
      "app.use('/api', userRoutes)",
      "app.use('/api', providerRoutes)",
      "app.use('/api', channelRoutes)",
      "app.use('/api', epgRoutes)",
      "app.use('/api', backupRoutes)",
      "app.use('/api', systemRoutes)",
      "app.use('/api/shares', shareRoutes)",
      "app.use('/api/proxy', proxyRoutes)",
      "app.use('/', streamRoutes)",
      "app.use('/', xtreamRoutes)",
      "app.use('/hdhr', hdhrRoutes)",
      'app.use(errorHandler)',
    ].forEach((expected) => {
      expect(appSource).toContain(expected);
    });
  });

  it('keeps production-facing middleware guardrails enabled', () => {
    const appSource = readRepoFile('src/app.js');

    expect(appSource).toContain('app.use(securityHeaders)');
    expect(appSource).toContain("express.json({ limit: '1mb' })");
    expect(appSource).toContain('process.env.ALLOWED_ORIGINS');
    expect(appSource).toContain('redactUrl(req.originalUrl || req.url)');
    expect(appSource).toContain("app.use('/api', apiLimiter)");
    expect(appSource).toContain("app.use('/player_api.php', apiLimiter)");
    expect(appSource).toContain('app.use(ipBlocker)');
  });

  it('keeps public compatibility endpoints registered outside the admin API', () => {
    const xtreamRoutes = readRepoFile('src/routes/xtream.js');
    const streamRoutes = readRepoFile('src/routes/streams.js');
    const hdhrRoutes = readRepoFile('src/routes/hdhr.js');

    expect(xtreamRoutes).toContain("router.get('/player_api.php'");
    expect(xtreamRoutes).toContain("router.get('/xmltv.php'");
    expect(xtreamRoutes).toContain("router.get('/api/player/playlist'");
    expect(streamRoutes).toContain("'/live/:username/:password/:stream_id.ts'");
    expect(streamRoutes).toContain("router.get('/movie/:username/:password/:stream_id.:ext'");
    expect(streamRoutes).toContain("'/live/token/auth/:stream_id.ts'");
    expect(hdhrRoutes).toContain("router.get(['/:token/discover.json'");
    expect(hdhrRoutes).toContain("router.get('/:token/auto/v:channelId'");
  });

  it('ships the identified Web UI vendor assets in the Docker image', () => {
    const bootstrapPath = path.join(root, 'public/vendor/bootstrap.bundle.min.js');
    const sortablePath = path.join(root, 'public/vendor/sortable.min.js');
    const indexHtml = readRepoFile('public/index.html');
    const playerHtml = readRepoFile('public/player.html');

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    expect(fs.existsSync(sortablePath)).toBe(true);
    expect(fs.readFileSync(bootstrapPath, 'utf8')).toContain('Bootstrap v5.3.8');
    expect(fs.readFileSync(sortablePath, 'utf8')).toContain('Sortable 1.15.6');
    expect(indexHtml).toContain('vendor/bootstrap.bundle.min.js');
    expect(indexHtml).toContain('vendor/sortable.min.js');
    expect(playerHtml).toContain('vendor/bootstrap.bundle.min.js');
    expect(readRepoFile('Dockerfile')).toContain('COPY public ./public');
  });
});
