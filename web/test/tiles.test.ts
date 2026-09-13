import { describe, expect, it } from 'vitest';
import { normalizeBluemapOpacity } from '../src/tiles';

describe('BlueMap opacity', () => {
  it('clamps visual opacity to Pixi-supported bounds and preserves the default on invalid input', () => {
    expect(normalizeBluemapOpacity(-0.1)).toBe(0);
    expect(normalizeBluemapOpacity(0.42)).toBe(0.42);
    expect(normalizeBluemapOpacity(1.5)).toBe(1);
    expect(normalizeBluemapOpacity(Number.NaN)).toBe(0.9);
  });
});