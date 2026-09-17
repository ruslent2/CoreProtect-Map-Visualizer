import { describe, expect, it } from 'vitest';
import { uuidColor } from '../src/colors';

describe('Minecraft locator UUID colors', () => {
  it('uses the low 24 bits of Java UUID.hashCode()', () => {
    expect(uuidColor('00000000-0000-0000-0000-000000000001', null)).toEqual([0, 0, 230]);
    expect(uuidColor('00000000-0000-0000-0000-000000000100', null)).toEqual([0, 230, 0]);
  });

  it('accepts UUIDs without hyphens and normalizes black to 90% brightness', () => {
    expect(uuidColor('00000000000000000000000000000001', null)).toEqual([0, 0, 230]);
    expect(uuidColor('00000000-0000-0000-0000-000000000000', null)).toEqual([230, 230, 230]);
  });

  it('generates Java offline UUID v3 when UUID is unavailable', () => {
    // UUID.nameUUIDFromBytes("OfflinePlayer:Steve") = 5627dd98-e6be-3c21-b8a8-e92344183641.
    expect(uuidColor(null, 'Steve')).toEqual(uuidColor('5627dd98-e6be-3c21-b8a8-e92344183641', null));
  });
});
