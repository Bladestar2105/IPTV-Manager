import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/db.js', () => ({ default: {} }));
import { getEpgRetentionDays } from '../src/services/epgRetentionService.js';
import { getArchiveDays, isArchiveProgram } from '../src/utils/archive.js';

describe('provider archive retention', () => {
  it('uses the longest valid enabled advertisement with a seven-day baseline', () => {
    const database = new Database(':memory:');
    database.exec('CREATE TABLE provider_channels (tv_archive INTEGER, tv_archive_duration INTEGER)');
    const insert = database.prepare('INSERT INTO provider_channels VALUES (?, ?)');
    try {
      expect(getEpgRetentionDays(7, database)).toBe(7);
      for (const row of [[1, 14], [1, 30], [0, 90], [1, -1], [1, 1.5], [1, 'invalid'], [1, 'Infinity']]) insert.run(...row);
      expect(getEpgRetentionDays(7, database)).toBe(30);
      expect(getEpgRetentionDays(60, database)).toBe(60);
    } finally {
      database.close();
    }
  });

  it.each([0, -1, 1.5, null, '', 'invalid', Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid provider duration %s', days => {
    expect(getArchiveDays({ tv_archive: 1, tv_archive_duration: days })).toBe(0);
  });

  it('requires a valid completed interval, including at the advertised boundary', () => {
    const now = 1800000000;
    const channel = { tv_archive: '1', tv_archive_duration: '30' };
    const start = now - 30 * 86400;
    expect(isArchiveProgram(channel, { start, stop: start + 60 }, now)).toBe(true);
    for (const program of [
      { start: start - 1, stop: start + 60 },
      { start: now - 1, stop: now + 1 },
      { start, stop: start },
      { start, stop: 'invalid' },
    ]) expect(isArchiveProgram(channel, program, now)).toBe(false);
  });
});
