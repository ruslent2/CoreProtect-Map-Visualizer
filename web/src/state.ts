import type { ColorMode } from './colors';

export interface BBox { x1: number; z1: number; x2: number; z2: number }

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

export function defaultFilters(): Filters {
  return {
    world: 'world', bbox: null,
    users: [], usersExcl: false,
    actions: [], actionsExcl: false,
    materials: [], materialsExcl: false,
    tFrom: null, tTo: null, y: null,
    limit: 50000, mode: 'user', mix: 0.25,
  };
}

export function filtersToQuery(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  p.set('world', f.world);
  if (f.bbox) {
    p.set('x1', String(Math.floor(f.bbox.x1))); p.set('x2', String(Math.ceil(f.bbox.x2)));
    p.set('z1', String(Math.floor(f.bbox.z1))); p.set('z2', String(Math.ceil(f.bbox.z2)));
  }
  if (f.users.length) { p.set('users', f.users.join(',')); if (f.usersExcl) p.set('usersExcl', '1'); }
  if (f.actions.length) { p.set('actions', f.actions.join(',')); if (f.actionsExcl) p.set('actionsExcl', '1'); }
  if (f.materials.length) { p.set('materials', f.materials.join(',')); if (f.materialsExcl) p.set('materialsExcl', '1'); }
  if (f.tFrom != null) p.set('tFrom', String(f.tFrom));
  if (f.tTo != null) p.set('tTo', String(f.tTo));
  if (f.y != null) p.set('y', String(f.y));
  p.set('limit', String(f.limit));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}
