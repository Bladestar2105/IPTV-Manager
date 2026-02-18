import { describe, it, expect } from 'vitest';
import { isAdultCategory } from '../src/utils/helpers.js';

describe('isAdultCategory', () => {
  const adultKeywords = [
    '18+', 'adult', 'xxx', 'porn', 'erotic', 'sex', 'nsfw',
    'for adults', 'erwachsene', '+18', '18 plus', 'mature',
    'sexy', 'hot'
  ];

  it('should return true for each keyword individually (case-insensitive)', () => {
    adultKeywords.forEach(kw => {
      expect(isAdultCategory(kw), `Expected keyword "${kw}" to match`).toBe(true);
      expect(isAdultCategory(kw.toUpperCase()), `Expected keyword "${kw.toUpperCase()}" to match`).toBe(true);
    });
  });

  it('should return true for names containing adult keywords', () => {
    expect(isAdultCategory('Channels 18+')).toBe(true);
    expect(isAdultCategory('My XXX Movies')).toBe(true);
    expect(isAdultCategory('Category for adults only')).toBe(true);
    expect(isAdultCategory('Top sexy picks')).toBe(true);
    expect(isAdultCategory('hot and spicy')).toBe(true);
  });

  it('should return false for non-adult categories', () => {
    const safeCategories = [
      'News',
      'Sports',
      'Kids',
      'Documentaries',
      'General Entertainment',
      '17+',
      'Weather',
      'Music',
      'Cooking',
      'Technology'
    ];
    safeCategories.forEach(name => {
      expect(isAdultCategory(name), `Expected "${name}" NOT to be an adult category`).toBe(false);
    });
  });

  it('should be case-insensitive', () => {
    expect(isAdultCategory('ADULT')).toBe(true);
    expect(isAdultCategory('Xxx')).toBe(true);
    expect(isAdultCategory('PORN')).toBe(true);
  });

  it('should handle names with multiple keywords', () => {
    expect(isAdultCategory('XXX 18+ Adult')).toBe(true);
  });

  it('should return true for "Adulting is hard" because it contains "adult"', () => {
    // This confirms the current behavior which uses substring matching
    expect(isAdultCategory('Adulting is hard')).toBe(true);
  });
});
