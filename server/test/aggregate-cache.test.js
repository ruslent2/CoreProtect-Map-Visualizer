import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { aggregateChunks, queryEvents } from '../src/queries.js';

function createStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE co_world (id INTEGER PRIMARY KEY, world TEXT);
    CREATE TABLE co_user (id INTEGER PRIMARY KEY, user TEXT, uuid TEXT);
    CREATE TABLE co_material_map (id INTEGER PRIMARY KEY, material TEXT);
    CREATE TABLE co_entity_map (id INTEGER PRIMARY KEY, entity TEXT);
    CREATE TABLE co_block (
      time INTEGER NOT NULL,
      user INTEGER NOT NULL,
      wid INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      z INTEGER NOT NULL,
      type INTEGER NOT NULL,
      action INTEGER NOT NULL,
      rolled_back INTEGER DEFAULT 0
    );
    CREATE TABLE co_container (
      time INTEGER NOT NULL,
      user INTEGER NOT NULL,
      wid INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      z INTEGER NOT NULL,
      type INTEGER NOT NULL,
      action INTEGER NOT NULL,
      amount INTEGER DEFAULT 1,
      rolled_back INTEGER DEFAULT 0
    );
    CREATE TABLE co_item (
      time INTEGER NOT NULL,
      user INTEGER NOT NULL,
      wid INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      z INTEGER NOT NULL,
      type INTEGER NOT NULL,
      action INTEGER NOT NULL,
      amount INTEGER DEFAULT 1,
      rolled_back INTEGER DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO co_world VALUES (?, ?)').run(1, 'world');
  db.prepare('INSERT INTO co_user VALUES (?, ?, ?)').run(1, 'tester', 'uuid');

  return {
    cfg: { defaultLimit: 50000 },
    meta: { worlds: [{ id: 1, world: 'world' }] },
    getDb: () => db,
    getMaps: () => ({
      worldNameToId: new Map([['world', 1]]),
      userNameToId: new Map([['tester', 1]]),
      materialNameToId: new Map(),
      entityNameToId: new Map(),
    }),
    close: () => db.close(),
  };
}

test('aggregateChunks does not return stale overview data', () => {
  const store = createStore();
  try {
    const insert = store.getDb().prepare(`
      INSERT INTO co_block (time, user, wid, x, y, z, type, action)
      VALUES (?, 1, 1, ?, 64, ?, 1, 0)
    `);

    insert.run(100, 0, 0);
    const first = aggregateChunks(store, {});
    assert.equal(first.chunks.length, 1);
    assert.equal(first.chunks[0].cnt, 1);

    insert.run(200, 32, 0);
    const second = aggregateChunks(store, {});
    assert.equal(second.chunks.length, 2);
    assert.equal(second.chunks.reduce((sum, chunk) => sum + chunk.cnt, 0), 2);
  } finally {
    store.close();
  }
});

test('queryEvents qualifies user filter when joining co_user', () => {
  const store = createStore();
  try {
    store.getDb().prepare('INSERT INTO co_material_map VALUES (?, ?)').run(1, 'STONE');
    store.getDb().prepare(`
      INSERT INTO co_block (time, user, wid, x, y, z, type, action)
      VALUES (?, 1, 1, 0, 64, 0, 1, 0)
    `).run(100);

    const result = queryEvents(store, { users: ['tester'] });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].nick, 'tester');
  } finally {
    store.close();
  }
});