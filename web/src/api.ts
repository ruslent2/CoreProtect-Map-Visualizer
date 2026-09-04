import type { Filters } from './state';
import { filtersToQuery } from './state';

export interface CpEvent {
  src: string; rowid_src: number; time: number;
  nick: string | null; uuid: string | null;
  world: string; x: number; y: number; z: number;
  material: string | null; amount: number | null;
  action: number; rolled_back: number;
}

export interface QueryResult {
  count: number; truncated: boolean; elapsedMs: number;
  events: CpEvent[]; bbox: { x1: number; x2: number; z1: number; z2: number } | null;
}

export interface Chunk {
  cx: number; cz: number; cnt: number; tmin: number; tmax: number; users: number;
  dominant: { nick: string | null; uuid: string | null; src: string; action: number } | null;
}

export async function apiQuery(f: Filters): Promise<QueryResult> {
  const r = await fetch(`/api/query?${filtersToQuery(f)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function apiAggregate(f: Filters): Promise<{ chunks: Chunk[]; elapsedMs: number }> {
  const r = await fetch(`/api/aggregate?${filtersToQuery(f)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function apiEvent(src: string, rowid: number) {
  const r = await fetch(`/api/event/${src}/${rowid}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{
    event: CpEvent;
    nearby: (CpEvent & { abs?: never })[];
  }>;
}

export async function apiMeta() {
  const r = await fetch('/api/meta');
  return r.json() as Promise<{
    worlds: { id: number; world: string }[];
    users: { id: number; nick: string; uuid: string | null }[];
    materials: string[];
    actions: { id: string; label: string }[];
  }>;
}

export async function apiSyncStatus() {
  const r = await fetch('/api/sync/status');
  return r.json();
}
