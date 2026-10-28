import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import uk from '../src/i18n/locales/uk.json';
import en from '../src/i18n/locales/en.json';
import { ACTION_CODES } from '../src/colors';

type Dictionary = { [key: string]: string | Dictionary };

function flatten(dictionary: Dictionary, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(dictionary)) {
    if (typeof value === 'string') result[prefix + key] = value;
    else Object.assign(result, flatten(value, `${prefix}${key}.`));
  }
  return result;
}

const ukFlat = flatten(uk as Dictionary);
const enFlat = flatten(en as Dictionary);
const placeholders = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]).sort();

describe('i18n dictionaries', () => {
  it('have the same keys in uk and en', () => {
    const ukKeys = Object.keys(ukFlat);
    const enKeys = Object.keys(enFlat);
    expect(ukKeys.filter(key => !(key in enFlat)), 'missing in en').toEqual([]);
    expect(enKeys.filter(key => !(key in ukFlat)), 'missing in uk').toEqual([]);
  });

  it('have no empty translations', () => {
    for (const [name, flat] of [['uk', ukFlat], ['en', enFlat]] as const) {
      const empty = Object.entries(flat).filter(([, value]) => value.trim() === '').map(([key]) => key);
      expect(empty, `empty values in ${name}`).toEqual([]);
    }
  });

  it('use the same interpolation placeholders in both languages', () => {
    const mismatched = Object.keys(ukFlat)
      .filter(key => key in enFlat && placeholders(ukFlat[key]).join() !== placeholders(enFlat[key]).join());
    expect(mismatched).toEqual([]);
  });

  it('translate every action code', () => {
    for (const code of ACTION_CODES) {
      expect(ukFlat[`actions.${code}`], `uk actions.${code}`).toBeTruthy();
      expect(enFlat[`actions.${code}`], `en actions.${code}`).toBeTruthy();
    }
  });

  it('contain every key used in the sources', () => {
    const srcDir = join(__dirname, '..', 'src');
    const sources = readdirSync(srcDir).filter(file => file.endsWith('.ts')).map(file => readFileSync(join(srcDir, file), 'utf8'));
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    const used = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/\bt\('([\w.:-]+)'/g)) used.add(match[1]);
    }
    for (const match of html.matchAll(/data-i18n="([\w.:-]+)"/g)) used.add(match[1]);
    for (const match of html.matchAll(/data-i18n-attr="[\w-]+:([\w.:-]+)"/g)) used.add(match[1]);
    const missing = [...used].filter(key => !(key in ukFlat) || !(key in enFlat));
    expect(used.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('contain the language modes used by the filter panel', () => {
    for (const mode of ['user', 'action', 'material', 'time']) {
      expect(ukFlat[`modes.${mode}`]).toBeTruthy();
      expect(enFlat[`modes.${mode}`]).toBeTruthy();
    }
  });
});
