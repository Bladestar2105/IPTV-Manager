import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isAdultCategory, getSetting, clearSettingsCache } from '../src/utils/helpers.js';

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

describe('getSetting', () => {
  let mockDb;
  let mockGet;

  beforeEach(() => {
    clearSettingsCache();
    mockGet = vi.fn();
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: mockGet
      })
    };
  });

  it('should query DB and return value when cache is empty', () => {
    const expectedValue = 'some_setting_value';
    mockGet.mockReturnValue({ value: expectedValue });

    const result = getSetting(mockDb, 'test_key', 'default');

    expect(result).toBe(expectedValue);
    expect(mockDb.prepare).toHaveBeenCalledWith('SELECT value FROM settings WHERE key = ?');
    expect(mockGet).toHaveBeenCalledWith('test_key');
  });

  it('should return cached value and not query DB on second call', () => {
    const expectedValue = 'cached_value';
    mockGet.mockReturnValue({ value: expectedValue });

    // First call - populates cache
    getSetting(mockDb, 'cache_key', 'default');

    // Clear mock history to ensure subsequent check is clean
    mockDb.prepare.mockClear();

    // Second call - should hit cache
    const result = getSetting(mockDb, 'cache_key', 'default');

    expect(result).toBe(expectedValue);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  it('should return default value when DB returns nothing', () => {
    mockGet.mockReturnValue(undefined);

    const defaultValue = 'default_val';
    const result = getSetting(mockDb, 'missing_key', defaultValue);

    expect(result).toBe(defaultValue);
  });

  it('should return default value when DB throws an error', () => {
    mockDb.prepare.mockImplementation(() => {
      throw new Error('DB Error');
    });

    const defaultValue = 'error_default';
    const result = getSetting(mockDb, 'error_key', defaultValue);

    expect(result).toBe(defaultValue);
  });

  it('should query DB again after cache is cleared', () => {
    const value1 = 'val1';
    const value2 = 'val2';

    // First call
    mockGet.mockReturnValue({ value: value1 });
    expect(getSetting(mockDb, 'clear_key', 'def')).toBe(value1);

    // Clear cache
    clearSettingsCache();

    // Update DB mock to return new value (simulating DB change)
    mockGet.mockReturnValue({ value: value2 });

    // Second call
    expect(getSetting(mockDb, 'clear_key', 'def')).toBe(value2);
    // Should be called twice in total (once for first call, once for second call)
    expect(mockDb.prepare).toHaveBeenCalledTimes(2);
  });
});
