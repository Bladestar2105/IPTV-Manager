import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = process.cwd();

function loadTranslations() {
  const source = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  const match = source.match(/const translations = (\{[\s\S]*?\n\});\n\n\/\//);
  if (!match) throw new Error('translations object not found');
  return vm.runInNewContext(`(${match[1]})`);
}

describe('i18n smoke checks', () => {
  it('keeps every locale complete for all English keys', () => {
    const translations = loadTranslations();
    const englishKeys = Object.keys(translations.en);

    Object.entries(translations).forEach(([locale, values]) => {
      const missing = englishKeys.filter(key => !(key in values));
      expect(missing, `${locale} missing keys`).toEqual([]);
    });
  });
});
