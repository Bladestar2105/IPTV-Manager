import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function ignorePatterns(relativePath) {
  return readRepoFile(relativePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

describe('repository smoke checks', () => {
  it('keeps Docker startup from recursively chowning /app', () => {
    const entrypoint = readRepoFile('scripts/docker-entrypoint.sh');

    expect(entrypoint).toContain('persist_geoip_data');
    expect(entrypoint).toContain('/data/geoip');
    expect(entrypoint).toContain('ln -s "$GEOIP_DATA_DIR" "$GEOIP_PACKAGE_DIR"');
    expect(entrypoint).toContain('owner_of /data');
    expect(entrypoint).toContain('chown -R "$APP_OWNER" /data');
    expect(entrypoint).toContain('chown "$APP_OWNER" /app');
    const appChownLines = entrypoint
      .split(/\r?\n/)
      .filter((line) => line.includes('chown') && line.includes('/app'));
    expect(appChownLines).toEqual(['      chown "$APP_OWNER" /app || true']);
  });

  it('keeps local runtime data out of Docker build context', () => {
    const patterns = ignorePatterns('.dockerignore');

    expect(patterns).toEqual(expect.arrayContaining([
      'node_modules',
      '.git',
      '.env',
      'data',
      'cache',
      'temp_*',
      'temp_uploads',
      'db.sqlite*',
      'epg.db*',
      'secret.key',
      'jwt.secret',
      'test-results',
      'playwright-report',
    ]));
  });

  it('keeps local runtime data ignored by Git', () => {
    const patterns = ignorePatterns('.gitignore');

    expect(patterns).toEqual(expect.arrayContaining([
      'node_modules/',
      '.env',
      'db.sqlite',
      'epg.db*',
      '*.sqlite',
      '*.sqlite-shm',
      '*.sqlite-wal',
      'secret.key',
      'jwt.secret',
      'cache/',
      'temp_*/',
      'temp_uploads/',
    ]));
  });

  it('documents development and agent guardrails', () => {
    const readme = readRepoFile('README.md');
    const development = readRepoFile('docs/DEVELOPMENT.md');
    const agents = readRepoFile('AGENTS.md');

    expect(readme).toContain('docs/DEVELOPMENT.md');
    expect(readme).toContain('docs/CONFIGURATION.md');
    expect(readme).toContain('docs/API_REFERENCE.md');
    expect(development).toContain('Docker Startup');
    expect(development).toContain('DATA_DIR');
    expect(development).toContain('docs/API_REFERENCE.md');
    expect(development).toContain('docs/CONFIGURATION.md');
    expect(agents).toContain('Primary package manager: `npm`');
    expect(agents).toContain('Do not recursively `chown /app`');
    expect(agents).toContain('Migrations must be idempotent');
    expect(agents).toContain('docs/API_REFERENCE.md');
  });

  it('does not keep an empty placeholder SQLite file in source', () => {
    expect(fs.existsSync(path.join(root, 'src/database/database.sqlite'))).toBe(false);
  });
});
