import { describe, expect, it } from 'vitest';
import { detailLodCells, shouldDisplayLodMarkers, shouldShowLodOverlay, TiledRenderState, tileRasterParts } from '../src/tiled-renderer';

function resource() {
  const value = { destroyed: 0, destroy() { value.destroyed++; } };
  return value;
}

describe('tiled raster planning', () => {
  it('never allocates a canvas from the overall data bounding box', () => {
    const parts = tileRasterParts(256, 128);
    expect(parts).toHaveLength(4);
    expect(parts.every(part => part.width <= 128 && part.height <= 128)).toBe(true);
    expect(parts.map(part => [part.x, part.z])).toEqual([[0, 0], [128, 0], [0, 128], [128, 128]]);
  });

  it('activates the explicit LOD overlay only below one pixel per world block', () => {
    expect(shouldShowLodOverlay(1 / 16)).toBe(true);
    expect(shouldShowLodOverlay(0.999)).toBe(true);
    expect(shouldShowLodOverlay(1)).toBe(false);
    expect(shouldShowLodOverlay(0)).toBe(false);
  });

  it('honours the local marker preference without affecting the scale threshold', () => {
    expect(shouldDisplayLodMarkers(true, 0.5)).toBe(true);
    expect(shouldDisplayLodMarkers(false, 0.5)).toBe(false);
    expect(shouldDisplayLodMarkers(true, 1)).toBe(false);
  });

  it('keeps an isolated detail-only event visible in its negative-coordinate LOD cell', () => {
    const event = { src: 'block', rowid_src: 7, time: 123, nick: 'Alex', uuid: null, world: 'world', x: -17, y: 64, z: -1, material: 'minecraft:stone', amount: null, action: 1, rolled_back: 0 };
    expect(detailLodCells([event])).toEqual([{ x: -32, z: -16, event }]);
  });
});

describe('tiled resource ownership and generations', () => {
  it('replacing one tile does not remove its neighbour', () => {
    const state = new TiledRenderState();
    const left = resource(), right = resource(), replacement = resource();
    state.begin(1);
    state.stageDetail(1, '0:0', { resources: [left], events: [], hitIndex: new Map() });
    state.stageDetail(1, '1:0', { resources: [right], events: [], hitIndex: new Map() });
    state.stageDetail(1, '0:0', { resources: [replacement], events: [], hitIndex: new Map() });
    expect(left.destroyed).toBe(1);
    expect(right.destroyed).toBe(0);
    state.commit(1);
    expect(state.detailTiles.get('1:0')?.resources[0]).toBe(right);
  });

  it('removing a detail tile destroys resources and removes its hit data', () => {
    const state = new TiledRenderState();
    const source = resource();
    state.begin(1);
    state.stageDetail(1, '0:0', { resources: [source], events: [], hitIndex: new Map([['0,0', []]]) });
    state.removeDetail(1, '0:0');
    expect(source.destroyed).toBe(1);
    state.commit(1);
    expect(state.detailTiles.has('0:0')).toBe(false);
  });

  it('rejects stale generation writes without changing committed tiles', () => {
    const state = new TiledRenderState();
    const committed = resource(), stale = resource();
    state.begin(1);
    state.stageDetail(1, '0:0', { resources: [committed], events: [], hitIndex: new Map() });
    state.commit(1);
    state.begin(2);
    expect(state.stageDetail(1, '1:0', { resources: [stale], events: [], hitIndex: new Map() })).toBe(false);
    expect(state.commit(1)).toBe(false);
    expect(state.detailTiles.get('0:0')?.resources[0]).toBe(committed);
    expect(state.detailTiles.has('1:0')).toBe(false);
  });

  it('destroys every staged or committed resource exactly once', () => {
    const state = new TiledRenderState();
    const replaced = resource(), staged = resource(), committed = resource();
    state.begin(1);
    state.stageDetail(1, '0:0', { resources: [replaced], events: [], hitIndex: new Map() });
    state.stageDetail(1, '0:0', { resources: [staged], events: [], hitIndex: new Map() });
    expect(replaced.destroyed).toBe(1);
    state.cancel(1);
    expect(staged.destroyed).toBe(1);
    state.begin(2);
    state.stageDetail(2, '1:0', { resources: [committed], events: [], hitIndex: new Map() });
    state.commit(2);
    state.clear();
    state.clear();
    expect(committed.destroyed).toBe(1);
  });
});
