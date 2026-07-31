import { describe, expect, it } from 'vitest';
import { decodeSeriesEpisodeId } from '../src/utils/seriesEpisodeId.js';

describe('legacy series episode identifiers', () => {
  it('decodes the provider/assignment prefix and remote episode', () => {
    expect(decodeSeriesEpisodeId('42000000123')).toEqual({ assignmentId: 42, remoteEpisodeId: 123 });
  });

  it('rejects malformed and ambiguous identifiers', () => {
    for (const value of [null, '', 'abc', '1.5', '1000000000', '0', '-1']) {
      expect(decodeSeriesEpisodeId(value)).toBe(null);
    }
  });
});
