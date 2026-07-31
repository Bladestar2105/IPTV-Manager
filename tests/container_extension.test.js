import { describe, expect, it } from 'vitest';
import { normalizeContainerExtension } from '../src/utils/containerExtension.js';

describe('normalizeContainerExtension', () => {
  it.each([
    ['mkv', 'mkv'],
    ['.MKV', 'mkv'],
    [' mp4 ', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/x-matroska', 'mkv'],
    ['video/mp2t', 'ts'],
    ['application/vnd.apple.mpegurl', 'm3u8'],
    ['application/x-mpegurl', 'm3u8'],
    ['application/dash+xml', 'mpd'],
  ])('normalizes %j to %j', (value, expected) => {
    expect(normalizeContainerExtension(value)).toBe(expected);
  });

  it.each([
    'mp4\r\n#EXTINF:-1,Injected',
    'mkv?token=secret',
    'mkv#fragment',
    '../mkv',
    'mkv/segment',
    'mkv\\segment',
    'percent%2fencoded',
    '',
    null,
    undefined,
    'thisextensionistoolong',
  ])('uses a safe fallback for %j', (value) => {
    expect(normalizeContainerExtension(value)).toBe('mp4');
  });

  it('normalizes the fallback and cannot return an unsafe fallback', () => {
    expect(normalizeContainerExtension('', '.TS')).toBe('ts');
    expect(normalizeContainerExtension('', '../bad')).toBe('mp4');
  });
});
