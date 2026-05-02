import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('documentation smoke checks', () => {
  it('links the maintainer docs from the README', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('docs/DEVELOPMENT.md');
    expect(readme).toContain('docs/CONFIGURATION.md');
    expect(readme).toContain('docs/API_REFERENCE.md');
    expect(readme).toContain('docs/SHARE_COMPANION_INTEGRATION.md');
  });

  it('documents runtime environment variables used by the server', () => {
    const configuration = readRepoFile('docs/CONFIGURATION.md');

    [
      'PORT',
      'NODE_ENV',
      'DATA_DIR',
      'JWT_EXPIRES_IN',
      'BCRYPT_ROUNDS',
      'JWT_SECRET',
      'ENCRYPTION_KEY',
      'INITIAL_ADMIN_PASSWORD',
      'TRUST_PROXY',
      'ALLOWED_ORIGINS',
      'REDIS_URL',
      'STREAM_MAX_AGE_MS',
      'STREAM_INACTIVITY_TIMEOUT_MS',
      'IS_SCHEDULER',
      'MAXMIND_LICENSE_KEY',
    ].forEach((envVar) => {
      expect(configuration).toContain(`\`${envVar}\``);
    });
  });

  it('documents the current public and admin route inventory', () => {
    const apiReference = readRepoFile('docs/API_REFERENCE.md');

    [
      'POST /api/login',
      'GET /api/verify-token',
      'POST /api/auth/otp/generate',
      'POST /api/auth/otp/verify',
      'POST /api/auth/otp/disable',
      'POST /api/player/token',
      'GET /api/users',
      'POST /api/users',
      'PUT /api/users/:id',
      'DELETE /api/users/:id',
      'GET /api/providers',
      'POST /api/providers/:id/sync',
      'GET /api/providers/:id/channels',
      'POST /api/providers/:providerId/import-category',
      'GET /api/users/:userId/categories',
      'POST /api/user-categories/bulk-delete',
      'PUT /api/user-categories/:id/adult',
      'GET /api/category-mappings/:providerId/:userId',
      'GET /api/epg/now',
      'GET /api/epg/schedule',
      'POST /api/epg-sources/update-all',
      'GET /api/epg-sources/available',
      'POST /api/mapping/auto',
      'GET /api/users/:userId/backups',
      'POST /api/users/:userId/backups/:id/restore',
      'GET /api/settings',
      'POST /api/export',
      'POST /api/import',
      'GET /api/sync-configs/:providerId/:userId',
      'GET /api/statistics',
      'POST /api/statistics/streams/:streamId/terminate',
      'POST /api/geoip/update',
      'POST /api/shares',
      'GET /share/:slug',
      'GET /api/proxy/image',
      'DELETE /api/proxy/picons',
      'GET /cpp',
      'GET /player_api.php',
      'GET /get.php',
      'GET /xmltv.php',
      'GET /api/player/playlist',
      'GET /api/player/channels.json',
      'GET /live/:username/:password/:stream_id.ts',
      'GET /live/:username/:password/:stream_id.m3u8',
      'GET /live/:username/:password/:stream_id.mp4',
      'GET /live/segment/:username/:password/seg.ts',
      'GET /movie/:username/:password/:stream_id.:ext',
      'GET /series/:username/:password/:episode_id.:ext',
      'GET /timeshift/:username/:password/:duration/:start/:stream_id.ts',
      'GET /live/token/auth/:stream_id.ts',
      'GET /movie/token/auth/:stream_id.:ext',
      'GET /series/token/auth/:episode_id.:ext',
      'GET /hdhr/:token/discover.json',
      'GET /hdhr/:token/lineup.json',
      'GET /hdhr/:token/auto/v:channelId',
      'GET /hdhr/:token/movie/:stream_id.:ext',
    ].forEach((endpoint) => {
      expect(apiReference).toContain(`\`${endpoint}\``);
    });
  });
});
