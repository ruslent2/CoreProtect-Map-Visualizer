import type { ColorMode } from './colors';

export interface BBox { x1: number; z1: number; x2: number; z2: number }

export type TimeSelectionMode = 'default' | 'range' | 'all';

export interface TimeSelection {
  mode: TimeSelectionMode;
  from: number | null;
  to: number | null;
}

export interface EffectiveTimeRange {
  from: number | null;
  to: number | null;
  error: string | null;
}

export const NON_MEANINGFUL_FILTER_VALUES = {
  users: new Set(['!#*']),
  materials: new Set<string>(),
  actions: new Set<string>(),
} as const;

// This is only used until the server-provided default can be supplied by the caller.
export const SAFE_DEFAULT_FILTER_LIMIT = 50_000;

export interface Filters {
  world: string;
  bbox: BBox | null;
  users: string[];        usersExcl: boolean;
  actions: string[];      actionsExcl: boolean;
  materials: string[];    materialsExcl: boolean;
  tFrom: number | null;
  tTo: number | null;
  y: number | null;
  limit: number;
  mode: ColorMode;
  mix: number;
}

export function defaultFilters(defaultLimit = SAFE_DEFAULT_FILTER_LIMIT): Filters {
  return {
    world: 'world', bbox: null,
    users: ['!#*'], usersExcl: false,
    actions: [], actionsExcl: false,
    materials: [], materialsExcl: false,
    tFrom: null, tTo: null, y: null,
    limit: defaultLimit, mode: 'user', mix: 0.1,
  };
}

/** Trim whitespace for comparisons without changing case-sensitive glob patterns. */
export function normalizeFilterToken(value: string): string {
  return value.trim();
}

export function isNonMeaningfulFilterValue(
  field: keyof typeof NON_MEANINGFUL_FILTER_VALUES,
  value: string,
): boolean {
  return NON_MEANINGFUL_FILTER_VALUES[field].has(normalizeFilterToken(value));
}

export function hasMeaningfulFilters(filters: Filters): boolean {
  return filters.bbox != null
    || filters.y != null
    || filters.users.some(value => !isNonMeaningfulFilterValue('users', value))
    || filters.materials.some(value => !isNonMeaningfulFilterValue('materials', value))
    || filters.actions.some(value => !isNonMeaningfulFilterValue('actions', value));
}

export function epochSecondsToLocalDateTime(epochSeconds: number | null): string | null {
  if (epochSeconds == null || !Number.isFinite(epochSeconds)) return null;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function localDateTimeToEpochSeconds(value: string | null): number | null {
  if (value == null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second = 0] = timePart.split(':').map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  // Date normalizes invalid calendar values, so compare all local components.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
  return Math.floor(date.getTime() / 1000);
}

export const TIME_PRESET_HOURS = {
  last6Hours: 6,
  last24Hours: 24,
  last7Days: 24 * 7,
  last30Days: 24 * 30,
} as const;

export function presetTimeRange(hours: number, nowSeconds: number): TimeSelection {
  return { mode: 'range', from: nowSeconds - hours * 3600, to: nowSeconds };
}

export function presetTimeSelection(
  preset: keyof typeof TIME_PRESET_HOURS,
  nowSeconds: number,
): TimeSelection {
  return presetTimeRange(TIME_PRESET_HOURS[preset], nowSeconds);
}

export function calculateEffectiveTime(timeSelection: TimeSelection, nowSeconds: number): EffectiveTimeRange {
  if (!Number.isFinite(nowSeconds)) return { from: null, to: null, error: 'Current time must be finite.' };
  if (timeSelection.mode === 'all') return { from: null, to: null, error: null };
  if (timeSelection.mode === 'default') {
    const range = presetTimeRange(6, nowSeconds);
    return { from: range.from, to: range.to, error: null };
  }

  const { from, to } = timeSelection;
  if ((from != null && !Number.isFinite(from)) || (to != null && !Number.isFinite(to))) {
    return { from: null, to: null, error: 'Time range values must be finite.' };
  }
  if (from != null && to != null && from > to) {
    return { from, to, error: 'The start time must not be after the end time.' };
  }
  return { from, to: to == null && from != null ? nowSeconds : to, error: null };
}

export function filtersToQuery(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  p.set('world', f.world);
  if (f.bbox) {
    p.set('x1', String(Math.floor(f.bbox.x1))); p.set('x2', String(Math.ceil(f.bbox.x2)));
    p.set('z1', String(Math.floor(f.bbox.z1))); p.set('z2', String(Math.ceil(f.bbox.z2)));
  }
  if (f.users.length) { p.set('users', f.users.join('\n')); }
  if (f.actions.length) { p.set('actions', f.actions.join(',')); if (f.actionsExcl) p.set('actionsExcl', '1'); }
  if (f.materials.length) { p.set('materials', f.materials.join(',')); if (f.materialsExcl) p.set('materialsExcl', '1'); }
  if (f.tFrom != null) p.set('tFrom', String(f.tFrom));
  if (f.tTo != null) p.set('tTo', String(f.tTo));
  if (f.y != null) p.set('y', String(f.y));
  p.set('limit', String(f.limit));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}
