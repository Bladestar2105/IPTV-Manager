import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let directory;
afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

function runStartup(overrides = {}) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-sqlite-temp-'));
  const moduleUrl = pathToFileURL(path.resolve('src/database/sqliteConnection.js')).href;
  const code = `const {openSqliteConnection}=await import(${JSON.stringify(moduleUrl)});
    const d=openSqliteConnection(':memory:');d.pragma('temp_store=FILE');d.pragma('temp.cache_size=-64');
    d.exec('CREATE TEMP TABLE probe(v BLOB);WITH RECURSIVE t(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<5000)INSERT INTO probe SELECT zeroblob(1024)FROM t');
    d.close();console.log(process.env.SQLITE_TMPDIR);`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, DATA_DIR: directory, SQLITE_TMPDIR: '', TMPDIR: '/nonexistent/iptv-temp', ...overrides },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split('\n').at(-1);
}

it('provides file-backed SQLite spill storage independently of installation or system temp paths', () => {
  const result = runStartup();
  expect(result.trim()).toBe(path.join(directory, 'sqlite-tmp'));
  expect(fs.statSync(result.trim()).isDirectory()).toBe(true);
  expect(fs.readdirSync(result.trim())).toEqual([]);
});

it('fails before opening SQLite when the configured temp path cannot be created', () => {
  expect(() => runStartup({ SQLITE_TMPDIR: '/dev/null/sqlite-tmp' })).toThrow();
});

it('honors an explicit SQLite temporary directory', () => {
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-explicit-sqlite-'));
  try { expect(runStartup({ SQLITE_TMPDIR: custom }).trim()).toBe(custom); }
  finally { fs.rmSync(custom, { recursive: true, force: true }); }
});
