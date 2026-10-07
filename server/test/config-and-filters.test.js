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

test('BlueMap proxy fetches and returns a tile', async () => {
  const store = {
    status: {},
    refreshMeta() {},
    getMeta: () => ({ worlds: [], users: [], materials: [], actions: [] }),
  };
  let requestedUrl = '';
  const app = await buildApp({
    store,
    cfg: { bluemap: { enabled: true, baseUrl: 'http://maps.example.test' } },
    rootDir: 'nonexistent-test-root',
    fetchImpl: async url => {
      requestedUrl = url;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      });
    },
  });
  try {
    const response = await app.inject('/api/bluemap/world/0/1/-1.png');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(requestedUrl, 'http://maps.example.test/maps/world/tiles/0/x1/z-1.png');
  } finally {
    await app.close();
  }
});

test('parseFilters accepts list inputs and clamps limits without a bypass', () => {
  const filters = parseFilters({
    users: ['alice,bob', 'carol'],
    materials: 'STONE\nDIRT',
    actions: ['break', 'place'],
    actionsExcl: '0', materialsExcl: 'true',
    x1: '1', x2: '2', z1: '-3', z2: '4', y: '64', tFrom: '10', tTo: '20',
    limit: '-1', pageSize: '5000',
  });

  assert.deepEqual(filters.users, ['alice', 'bob', 'carol']);
  assert.deepEqual(filters.materials, ['STONE', 'DIRT']);
  assert.deepEqual(filters.actions, ['break', 'place']);
  assert.equal(filters.limit, 1);
  assert.equal(filters.pageSize, 5000);
  assert.equal(filters.x1, 1);
  assert.equal(filters.actionsExcl, false);
  assert.equal(filters.materialsExcl, true);
});

for (const [query, message] of [
  [{ x1: '3', x2: '2' }, 'reverse x bbox'],
  [{ z1: '3', z2: '2' }, 'reverse z bbox'],
  [{ tFrom: '20', tTo: '10' }, 'reverse time range'],
  [{ y: '1.5' }, 'fractional number'],
  [{ limit: 'Infinity' }, 'non-finite number'],
  [{ y: '9007199254740992' }, 'unsafe integer'],
  [{ x1: '1', x2: '2' }, 'partial bbox'],
  [{ actions: 'unknown' }, 'unknown action'],
  [{ actionsExcl: 'yes' }, 'ambiguous boolean'],
  [{ actionsExcl: ['true', 'false'] }, 'repeated boolean'],
  [{ users: Array.from({ length: 101 }, (_, index) => `user-${index}`) }, 'too many patterns'],
  [{ materials: 'x'.repeat(257) }, 'overlong pattern'],
]) {
  test(`parseFilters rejects ${message}`, () => {
    assert.throws(() => parseFilters(query), error => error.statusCode === 400);
  });
}
