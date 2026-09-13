import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = process.cwd();

function loadTranslations() {
  const source = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  const match = source.match(/const translations = (\{[\s\S]*?\n\});\n\n\/\//);
  if (!match) throw new Error('translations object not found');
  const aiSource = fs.readFileSync(path.join(root, 'public/ai-i18n.js'), 'utf8');
  return vm.runInNewContext(`const translations = ${match[1]};\n${aiSource}\ntranslations;`);
}

describe('i18n smoke checks', () => {
  it('keeps every locale complete for all base and AI keys', () => {
    const translations = loadTranslations();
    const keys = [...new Set(Object.values(translations).flatMap(Object.keys))];

    Object.entries(translations).forEach(([locale, values]) => {
      const missing = keys.filter(key => typeof values[key] !== 'string' || !values[key].trim());
      expect(missing, `${locale} missing keys`).toEqual([]);
    });
  });

  it('keeps replacement placeholders consistent in every locale, including AI', () => {
    const translations = loadTranslations();
    const placeholders = text => (text.match(/\{\w+\}/g) || []).sort();
    Object.entries(translations).forEach(([locale, values]) => {
      Object.entries(translations.en).forEach(([key, english]) => {
        expect(placeholders(values[key]), `${locale}.${key} placeholders`).toEqual(placeholders(english));
      });
    });
  });

  it('identifies the optional AI integration as experimental in every locale', () => {
    const translations = loadTranslations();
    for (const [locale, experimental] of Object.entries({en: /experimental/i, de: /experimentell/i, fr: /expérimental/i, el: /πειραματικ/i})) {
      expect(translations[locale].ai_intro, locale).toMatch(experimental);
    }
  });

  it('renders playback failure status in the selected locale', () => {
    const translations = loadTranslations();
    const source = fs.readFileSync(path.join(root, 'public/player.js'), 'utf8');
    const functions = ['setPlayerStatus', 'handlePlaybackFailure'].map(name => {
      const match = source.match(new RegExp(`  function ${name}\\([\\s\\S]*?\\n  \\}`));
      if (!match) throw new Error(`${name} not found`);
      return match[0];
    }).join('\n');
    for (const [locale, error] of Object.entries({en: 'Error', de: 'Fehler', fr: 'Erreur', el: 'Σφάλμα'})) {
      const playerStatus = {innerHTML: ''};
      vm.runInNewContext(`${functions}\nhandlePlaybackFailure('live');`, {
        playerStatus, t: key => translations[locale][key] || key,
        showToast() {}, console: {error() {}}
      });
      expect(playerStatus.innerHTML, locale).toContain(`>${error}</span>`);
    }
  });

  it('translates every literal UI key used by the public pages and scripts', () => {
    const translations = loadTranslations();
    const missing = [];
    const files = fs.readdirSync(path.join(root, 'public')).filter(file => /\.(html|js)$/.test(file) && !file.endsWith('i18n.js'));
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, 'public', file), 'utf8');
      const matches = source.matchAll(/\bt\(\s*['"]([^'"]+)['"]|data-i18n(?:-[\w-]+)?=['"]([^'"]+)['"]/g);
      const keys = new Set([...matches].map(match => match[1] || match[2]));
      for (const match of source.matchAll(/\btr\(\s*['"]([^'"]+)['"]/g)) keys.add(`ai_${match[1]}`);
      for (const match of source.matchAll(/\bsetLoadingState\([^,\n]+,[^,\n]+,\s*([^)\n]*)\)/g)) {
        for (const key of match[1].matchAll(/['"]([\w]+)['"]/g)) keys.add(key[1]);
      }
      for (const key of keys) {
        for (const [locale, values] of Object.entries(translations)) {
          if (!values[key]) missing.push(`${file}: ${locale}.${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the complete Stalker/MAG UI localized', () => {
    const translations = loadTranslations();
    const stalkerKeys = [
      'stalkerMag',
      'stalkerExperimentalPortal',
      'stalkerPortalUrl',
      'stalkerCopyPortalUrl',
      'stalkerDeviceMac',
      'stalkerParentalPin',
      'stalkerParentalPinOptional',
      'stalkerPinConfigured',
      'stalkerPinNotConfigured',
      'stalkerSetPin',
      'stalkerClearPin',
      'stalkerClearPinConfirm',
      'stalkerAddDevice',
      'stalkerNoDevices',
      'stalkerLastSeen',
      'stalkerNever',
      'stalkerEnable',
      'stalkerDisable',
      'stalkerDelete',
      'stalkerDeleteDeviceConfirm',
      'stalkerLoadingDevices',
      'stalkerDeviceError',
      'stalkerPortalPageTitle',
      'stalkerPortalApiAvailable',
      'stalkerPortalSetup'
    ];

    Object.entries(translations).forEach(([locale, values]) => {
      const missing = stalkerKeys.filter(key => !values[key]);
      expect(missing, `${locale} missing Stalker/MAG keys`).toEqual([]);
    });
  });
});
