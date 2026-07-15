import { describe, expect, it } from 'vitest';
import { decodeSeriesEpisodeId, encodeSeriesEpisodeId, SERIES_EPISODE_OFFSET } from '../src/utils/seriesEpisodeId.js';

describe('series episode identifiers', () => {
  it('round-trips an exact user-channel assignment and remote episode', () => {
    const encoded = encodeSeriesEpisodeId(42, 123);

    expect(encoded).toBe('42000000123');
    expect(decodeSeriesEpisodeId(encoded)).toEqual({ assignmentId: 42, remoteEpisodeId: 123 });
  });

  it('rejects malformed and ambiguous identifiers', () => {
    for (const value of [null, '', 'abc', '1.5', '1000000000', '0', '-1']) {
      expect(decodeSeriesEpisodeId(value)).toBe(null);
    }
    expect(encodeSeriesEpisodeId(0, 1)).toBe(null);
    expect(encodeSeriesEpisodeId(1, 0)).toBe(null);
    expect(encodeSeriesEpisodeId(1, SERIES_EPISODE_OFFSET)).toBe(null);
    expect(encodeSeriesEpisodeId(Number.MAX_SAFE_INTEGER, 1)).toBe(null);
  });
});
