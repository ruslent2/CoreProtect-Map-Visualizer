import { describe, expect, it } from 'vitest';
import {
  coordinateToTile,
  dedupeEvents,
  distributeEventsByTile,
  eventId,
  prioritizeTileQueue,
  sortOccupiedTiles,
  tileBounds,
} from '../src/tile-utils';

describe('tile coordinates and bounds', () => {
  it('uses floor division for positive and negative coordinates', () => {
    expect(coordinateToTile(255, 256)).toBe(0);
    expect(coordinateToTile(256, 256)).toBe(1);
    expect(coordinateToTile(-1, 256)).toBe(-1);
    expect(coordinateToTile(-256, 256)).toBe(-1);
    expect(coordinateToTile(-257, 256)).toBe(-2);
  });

  it('creates non-overlapping half-open tile bounds', () => {
    expect(tileBounds({ x: -1, z: 0 }, 256)).toEqual({ x1: -256, z1: 0, x2: 0, z2: 256 });
    expect(tileBounds({ x: 0, z: 0 }, 256).x1).toBe(tileBounds({ x: -1, z: 0 }, 256).x2);
  });
});

describe('tile event and request helpers', () => {
  const events = [
    { src: 'a', rowid_src: 1, x: -1, z: 0 },
    { src: 'a', rowid_src: 2, x: 0, z: 0 },
    { src: 'b', rowid_src: 3, x: 300, z: -1 },
  ];

  it('distributes events into exactly one tile each', () => {
    const grouped = distributeEventsByTile(events, 256);
    expect([...grouped.entries()]).toEqual([
      ['-1:0', [events[0]]],
      ['0:0', [events[1]]],
      ['1:-1', [events[2]]],
    ]);
  });

  it('sorts tiles deterministically by distance from the applied camera tile', () => {
    expect(sortOccupiedTiles([{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: 0 }], { x: 0, z: 0 }))
      .toEqual([{ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 0 }]);
  });

  it('moves a priority request without duplicates', () => {
    expect(prioritizeTileQueue(['a', 'b', 'a', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });

  it('deduplicates events by source and source row ID', () => {
    const duplicates = [...events, { ...events[0] }, { ...events[0], src: 'b' }];
    expect(dedupeEvents(duplicates).map(eventId)).toEqual(['a:1', 'a:2', 'b:3', 'b:1']);
  });
});