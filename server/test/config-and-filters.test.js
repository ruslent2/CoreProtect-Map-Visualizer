import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { buildApp } from '../src/index.js';
import { parseFilters } from '../src/queries.js';

test('normalizeConfig supplies safe tiled renderer defaults and clamps values', () => {
  const normalized = normalizeConfig({
    defaultLimit: 0,
    bluemap: { enabled: true },
    coreProtectTiles: {
      tileSize: 259,
      maxConcurrentRequests: 10,
      detailPageSize: 99,
      maxTextureSize: 64,
    },
  });

  assert.equal(normalized.defaultLimit, 1);
  assert.deepEqual(normalized.bluemap, { enabled: true });
  assert.deepEqual(normalized.materialNamePrefixesToStrip, []);
  assert.deepEqual(normalized.coreProtectTiles, {
    tileSize: 256,
    maxConcurrentRequests: 4,
    detailPageSize: 100,
    maxTextureSize: 256,
  });
  assert.equal(normalizeConfig({}).defaultLimit, 50000);
});

test('normalizeConfig uses only a valid configured material prefix array', () => {
  assert.deepEqual(
    normalizeConfig({ materialNamePrefixesToStrip: [' Minecraft: ', 42, 'custom:', '   '] }).materialNamePrefixesToStrip,
    ['minecraft:', 'custom:'],
  );
  assert.deepEqual(normalizeConfig({ materialNamePrefixesToStrip: 'minecraft:' }).materialNamePrefixesToStrip, []);
});

test('buildApp exposes normalized tiled configuration', async () => {
  const store = {
    status: {},
    refreshMeta() {},
    getMeta: () => ({ worlds: [], users: [], materials: [], actions: [] }),
  };
  const app = await buildApp({
    store,
    cfg: { defaultLimit: 0, coreProtectTiles: { tileSize: 259, maxTextureSize: 64 } },
    rootDir: 'nonexistent-test-root',
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      bluemap: { enabled: false },
      defaultLimit: 1,
      materialNamePrefixesToStrip: [],
      coreProtectTiles: { tileSize: 256, maxConcurrentRequests: 2, detailPageSize: 5000, maxTextureSize: 256 },
    });
  } finally {
    await app.close();
  }
});

test('parseFilters accepts list inputs and clamps limits without a bypass', () => {
  const filters = parseFilters({
    users: ['alice,bob', 'carol'],
    materials: 'STONE\nDIRT',
    actions: ['break', 'place'],
    x1: '1', x2: '2', z1: '-3', z2: '4', y: '64', tFrom: '10', tTo: '20',
    limit: '-1', pageSize: '5000',
  });

  assert.deepEqual(filters.users, ['alice', 'bob', 'carol']);
  assert.deepEqual(filters.materials, ['STONE', 'DIRT']);
  assert.deepEqual(filters.actions, ['break', 'place']);
  assert.equal(filters.limit, 1);
  assert.equal(filters.pageSize, 5000);
  assert.equal(filters.x1, 1);
});

for (const [query, message] of [
  [{ x1: '3', x2: '2' }, 'reverse x bbox'],
  [{ z1: '3', z2: '2' }, 'reverse z bbox'],
  [{ tFrom: '20', tTo: '10' }, 'reverse time range'],
  [{ y: '1.5' }, 'fractional number'],
  [{ limit: 'Infinity' }, 'non-finite number'],
]) {
  test(`parseFilters rejects ${message}`, () => {
    assert.throws(() => parseFilters(query), error => error.statusCode === 400);
  });
}
