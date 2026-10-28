import { describe, expect, it } from 'vitest';
import {
  calculateEffectiveTime,
  defaultFilters,
  epochSecondsToLocalDateTime,
  hasMeaningfulFilters,
  isNonMeaningfulFilterValue,
  localDateTimeToEpochSeconds,
  filtersToQuery,
  formatYRange,
  parseYRange,
  presetTimeSelection,
  sameYRange,
  yRangeContains,
} from '../src/state';

describe('Y range', () => {
  it('parses a single level and ranges in either order', () => {
    expect(parseYRange('64')).toEqual({ min: 64, max: 64 });
    expect(parseYRange('83-107')).toEqual({ min: 83, max: 107 });
    expect(parseYRange('107-83')).toEqual({ min: 83, max: 107 });
    expect(parseYRange(' 107 – 83 ')).toEqual({ min: 83, max: 107 });
    expect(parseYRange('83:107')).toEqual({ min: 83, max: 107 });
    expect(parseYRange('83..107')).toEqual({ min: 83, max: 107 });
  });

  it('supports negative levels', () => {
    expect(parseYRange('-64')).toEqual({ min: -64, max: -64 });
    expect(parseYRange('-64..-30')).toEqual({ min: -64, max: -30 });
    expect(parseYRange('-64--30')).toEqual({ min: -64, max: -30 });
    expect(parseYRange('-64-30')).toEqual({ min: -64, max: 30 });
  });

  it('treats empty input as no filter and rejects garbage', () => {
    expect(parseYRange('')).toBeNull();
    expect(parseYRange('   ')).toBeNull();
    expect(parseYRange('abc')).toBeUndefined();
    expect(parseYRange('1.5')).toBeUndefined();
    expect(parseYRange('10-')).toBeUndefined();
    expect(parseYRange('1-2-3')).toBeUndefined();
  });

  it('formats back to a string that parses to the same range', () => {
    for (const text of ['64', '83-107', '-64..-30', '-64..30']) {
      expect(formatYRange(parseYRange(text) ?? null)).toBe(text);
    }
    expect(formatYRange(null)).toBe('');
  });

  it('compares and tests membership with inclusive bounds', () => {
    expect(sameYRange(null, null)).toBe(true);
    expect(sameYRange({ min: 1, max: 2 }, { min: 1, max: 2 })).toBe(true);
    expect(sameYRange({ min: 1, max: 2 }, null)).toBe(false);
    expect(yRangeContains(null, 999)).toBe(true);
    expect(yRangeContains({ min: 83, max: 107 }, 83)).toBe(true);
    expect(yRangeContains({ min: 83, max: 107 }, 107)).toBe(true);
    expect(yRangeContains({ min: 83, max: 107 }, 108)).toBe(false);
  });

  it('is sent to the server as yMin and yMax', () => {
    const query = new URLSearchParams(filtersToQuery({ ...defaultFilters(), y: { min: 83, max: 107 } }));
    expect(query.get('yMin')).toBe('83');
    expect(query.get('yMax')).toBe('107');
    expect(new URLSearchParams(filtersToQuery(defaultFilters())).has('yMin')).toBe(false);
  });
});

describe('local datetime helpers', () => {
  it('formats and parses local wall-clock values without assuming UTC', () => {
    const local = new Date(2026, 4, 6, 7, 8, 9);
    const epoch = Math.floor(local.getTime() / 1000);
    expect(epochSecondsToLocalDateTime(epoch)).toBe('2026-05-06T07:08:09');
    expect(localDateTimeToEpochSeconds('2026-05-06T07:08:09')).toBe(epoch);
  });

  it('returns null for absent or invalid datetime values', () => {
    expect(epochSecondsToLocalDateTime(null)).toBeNull();
    expect(localDateTimeToEpochSeconds(null)).toBeNull();
    expect(localDateTimeToEpochSeconds('2026-02-30T10:00:00')).toBeNull();
    expect(localDateTimeToEpochSeconds('not-a-datetime')).toBeNull();
  });
});

describe('time selection', () => {
  const now = 1_000_000;

  it('creates all supported preset ranges', () => {
    expect(presetTimeSelection('last6Hours', now)).toEqual({ mode: 'range', from: now - 6 * 3600, to: now });
    expect(presetTimeSelection('last24Hours', now).from).toBe(now - 24 * 3600);
    expect(presetTimeSelection('last7Days', now).from).toBe(now - 7 * 24 * 3600);
    expect(presetTimeSelection('last30Days', now).from).toBe(now - 30 * 24 * 3600);
  });

  it('calculates default, all, and open-ended effective times', () => {
    expect(calculateEffectiveTime({ mode: 'default', from: null, to: null }, now))
      .toEqual({ from: now - 6 * 3600, to: now, error: null });
    expect(calculateEffectiveTime({ mode: 'all', from: 1, to: 2 }, now))
      .toEqual({ from: null, to: null, error: null });
    expect(calculateEffectiveTime({ mode: 'range', from: 10, to: null }, now))
      .toEqual({ from: 10, to: now, error: null });
    expect(calculateEffectiveTime({ mode: 'range', from: null, to: 20 }, now))
      .toEqual({ from: null, to: 20, error: null });
  });

  it('returns an error for a reversed range', () => {
    expect(calculateEffectiveTime({ mode: 'range', from: 20, to: 10 }, now).error).toMatch(/start time/i);
  });
});

describe('meaningful filter policy', () => {
  it('defaults to the compatibility user glob', () => {
    expect(defaultFilters().users).toEqual(['!#*']);
  });

  it('trims sentinel comparisons without changing token case', () => {
    expect(isNonMeaningfulFilterValue('users', ' !#* ')).toBe(true);
    expect(isNonMeaningfulFilterValue('users', '!#A')).toBe(false);
  });

  it('recognizes only spatial, y, and real list filters as meaningful', () => {
    const filters = defaultFilters();
    expect(hasMeaningfulFilters(filters)).toBe(false);
    expect(hasMeaningfulFilters({ ...filters, world: 'nether', mode: 'action', mix: 1, limit: 1 })).toBe(false);
    expect(hasMeaningfulFilters({ ...filters, bbox: { x1: 0, x2: 1, z1: 0, z2: 1 } })).toBe(true);
    expect(hasMeaningfulFilters({ ...filters, y: { min: 64, max: 64 } })).toBe(true);
    expect(hasMeaningfulFilters({ ...filters, users: ['Alice'] })).toBe(true);
    expect(hasMeaningfulFilters({ ...filters, materials: ['minecraft:stone'] })).toBe(true);
    expect(hasMeaningfulFilters({ ...filters, actions: ['1'] })).toBe(true);
  });
});