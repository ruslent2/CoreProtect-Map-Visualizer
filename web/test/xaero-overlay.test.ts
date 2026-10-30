import { describe, expect, it } from 'vitest';
import { normalizeXaeroPlacement } from '../src/xaero-overlay';

describe('normalizeXaeroPlacement', () => {
  it('keeps valid values', () => {
    expect(normalizeXaeroPlacement({ x: -1200, z: 340, pxPerBlock: 2 })).toEqual({ x: -1200, z: 340, pxPerBlock: 2 });
  });

  it('falls back for missing, non-finite or non-positive input', () => {
    expect(normalizeXaeroPlacement({})).toEqual({ x: 0, z: 0, pxPerBlock: 1 });
    expect(normalizeXaeroPlacement({ x: NaN, z: Infinity, pxPerBlock: 0 })).toEqual({ x: 0, z: 0, pxPerBlock: 1 });
    expect(normalizeXaeroPlacement({ pxPerBlock: -3 }).pxPerBlock).toBe(1);
  });
});
