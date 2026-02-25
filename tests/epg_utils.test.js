import { describe, it, expect } from 'vitest';
import { decodeXml, cleanName, levenshtein, getSimilarity } from '../src/utils/epgUtils.js';

describe('EPG Utilities', () => {

  describe('decodeXml', () => {
    it('should return empty string for null or undefined input', () => {
      expect(decodeXml(null)).toBe('');
      expect(decodeXml(undefined)).toBe('');
      expect(decodeXml('')).toBe('');
    });

    it('should return the original string if no entities are present', () => {
      expect(decodeXml('Hello World')).toBe('Hello World');
      expect(decodeXml('12345')).toBe('12345');
    });

    it('should decode XML entities correctly', () => {
      expect(decodeXml('&quot;')).toBe('"');
      expect(decodeXml('&apos;')).toBe("'");
      expect(decodeXml('&lt;')).toBe('<');
      expect(decodeXml('&gt;')).toBe('>');
      expect(decodeXml('&amp;')).toBe('&');
    });

    it('should decode multiple occurrences of entities', () => {
      expect(decodeXml('Foo &amp; Bar &amp; Baz')).toBe('Foo & Bar & Baz');
      expect(decodeXml('&lt;tag&gt;content&lt;/tag&gt;')).toBe('<tag>content</tag>');
    });

    it('should decode mixed entities in a single string', () => {
      const input = 'Q&amp;A: &quot;Is 5 &lt; 10?&quot; Yes/No';
      const expected = 'Q&A: "Is 5 < 10?" Yes/No';
      expect(decodeXml(input)).toBe(expected);
    });
  });

  describe('cleanName', () => {
    it('should return empty string for null or undefined input', () => {
      expect(cleanName(null)).toBe('');
      expect(cleanName(undefined)).toBe('');
      expect(cleanName('')).toBe('');
    });

    it('should lowercase the name', () => {
      expect(cleanName('ABC')).toBe('abc');
    });

    it('should remove "Provider|" prefix', () => {
      expect(cleanName('Provider| Channel Name')).toBe('channel name');
      expect(cleanName('MyTV| HBO')).toBe('hbo');
    });

    it('should remove country codes', () => {
      expect(cleanName('RTL (DE)')).toBe('rtl');
      expect(cleanName('CNN US')).toBe('cnn');
      expect(cleanName('BBC UK')).toBe('bbc');
      expect(cleanName('Canal+ FR')).toBe('canal'); // + is handled by special chars/normalization
      expect(cleanName('TVP PL')).toBe('tvp');
    });

    it('should remove technical suffixes', () => {
      expect(cleanName('Sky Sports HD')).toBe('sky sports');
      expect(cleanName('Discovery FHD')).toBe('discovery');
      expect(cleanName('Movie 4K')).toBe('movie');
      expect(cleanName('Channel 50FPS')).toBe('channel');
      expect(cleanName('Stream HEVC')).toBe('stream');
      expect(cleanName('Video RAW')).toBe('video');
    });

    it('should remove common superscript characters', () => {
      expect(cleanName('Channel ᴿᴬᵂ')).toBe('channel');
    });

    it('should remove time shifts', () => {
      expect(cleanName('Channel +1')).toBe('channel');
      expect(cleanName('Channel -2')).toBe('channel');
    });

    it('should clean special characters', () => {
      expect(cleanName('Channel.Name')).toBe('channel name');
      expect(cleanName('Channel_Name')).toBe('channel name');
      expect(cleanName('Channel (Test)')).toBe('channel test');
      expect(cleanName('Channel [HQ]')).toBe('channel hq');
    });

    it('should normalize common terms', () => {
      expect(cleanName('Disney Plus')).toBe('disney');
      expect(cleanName('RTL II')).toBe('rtl 2');
      expect(cleanName('RTL III')).toBe('rtl 3');
      expect(cleanName('BBC One')).toBe('bbc 1');
    });

    it('should handle complex names with multiple cleanups', () => {
      const input = 'Provider| Sky Cinema (DE) FHD +1';
      // Provider| -> removed
      // Sky Cinema (DE) FHD +1 -> sky cinema (de) fhd +1
      // (de) -> removed
      // fhd -> removed
      // +1 -> removed
      // Result: sky cinema
      expect(cleanName(input)).toBe('sky cinema');
    });

    it('should trim extra spaces', () => {
      expect(cleanName('  Channel   Name  ')).toBe('channel name');
    });
  });

  describe('levenshtein', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshtein('abc', 'abc')).toBe(0);
      expect(levenshtein('', '')).toBe(0);
    });

    it('should calculate distance for insertions', () => {
      expect(levenshtein('abc', 'abcd')).toBe(1);
      expect(levenshtein('abc', 'abcde')).toBe(2);
    });

    it('should calculate distance for deletions', () => {
      expect(levenshtein('abc', 'ab')).toBe(1);
      expect(levenshtein('abc', 'a')).toBe(2);
    });

    it('should calculate distance for substitutions', () => {
      expect(levenshtein('abc', 'abd')).toBe(1);
      expect(levenshtein('abc', 'xyz')).toBe(3);
    });

    it('should handle empty strings correctly', () => {
      expect(levenshtein('', 'abc')).toBe(3);
      expect(levenshtein('abc', '')).toBe(3);
    });

    it('should respect the limit parameter', () => {
      // Distance is 3, limit is 2 -> should return > limit (usually limit + 1)
      expect(levenshtein('abc', 'xyz', 2)).toBeGreaterThan(2);

      // Distance is 2, limit is 2 -> should return 2
      expect(levenshtein('abc', 'ade', 2)).toBe(2);

      // Distance is 1, limit is 2 -> should return 1
      expect(levenshtein('abc', 'abd', 2)).toBe(1);
    });

    it('should optimize for length difference greater than limit', () => {
       // Length diff is 4, limit is 2 -> immediate exit
       expect(levenshtein('a', 'abcde', 2)).toBeGreaterThan(2);
    });
  });

  describe('getSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      expect(getSimilarity('abc', 'abc')).toBe(1.0);
      expect(getSimilarity('', '')).toBe(1.0);
    });

    it('should return 0.0 for completely different strings exceeding limit', () => {
      // "abc" vs "xyz" -> distance 3. max(len) = 3. limit = 3*(1-0) = 3.
      // wait, logic is: limit = floor(len * (1 - threshold)). default threshold 0 -> limit = len.
      // dist 3 <= limit 3. similarity = 1 - 3/3 = 0.
      expect(getSimilarity('abc', 'xyz')).toBe(0);
    });

    it('should return partial similarity', () => {
      // 'abc', 'abd' -> distance 1, len 3. sim = 1 - 1/3 = 0.666...
      expect(getSimilarity('abc', 'abd')).toBeCloseTo(0.666, 2);
    });

    it('should respect threshold parameter', () => {
      // 'abc', 'abd' -> distance 1, len 3.
      // threshold 0.8: limit = floor(3 * (1 - 0.8)) = floor(0.6) = 0.
      // dist 1 > limit 0 -> returns 0.
      expect(getSimilarity('abc', 'abd', 0.8)).toBe(0);

      // threshold 0.5: limit = floor(3 * (1 - 0.5)) = floor(1.5) = 1.
      // dist 1 <= limit 1 -> returns 1 - 1/3 = 0.666...
      expect(getSimilarity('abc', 'abd', 0.5)).toBeCloseTo(0.666, 2);
    });

    it('should handle empty vs non-empty strings', () => {
      // one empty: dist = len, sim = 1 - len/len = 0
      expect(getSimilarity('', 'abc')).toBe(0);
      expect(getSimilarity('abc', '')).toBe(0);
    });
  });

});
