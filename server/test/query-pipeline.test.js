import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildApp } from '../src/index.js';

function store() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE co_world(id INTEGER PRIMARY KEY,world TEXT);CREATE TABLE co_user(id INTEGER PRIMARY KEY,user TEXT,uuid TEXT);CREATE TABLE co_material_map(id INTEGER PRIMARY KEY,material TEXT);CREATE TABLE co_entity_map(id INTEGER PRIMARY KEY,entity TEXT);${['block','container','item'].map(name=>`CREATE TABLE co_${name}(time INTEGER,user INTEGER,wid INTEGER,x INTEGER,y INTEGER,z INTEGER,type INTEGER,action INTEGER,amount INTEGER DEFAULT 1,rolled_back INTEGER DEFAULT 0);`).join('')}`);
  db.prepare('INSERT INTO co_world VALUES(1,?)').run('world'); db.prepare('INSERT INTO co_user VALUES(1,?,?)').run('alice','a'); db.prepare('INSERT INTO co_user VALUES(2,?,?)').run('#environment','e'); db.prepare('INSERT INTO co_material_map VALUES(1,?)').run('STONE');
  const maps = { worldNameToId:new Map([['world',1]]), userNameToId:new Map([['alice',1],['#environment',2]]), userIdToUser:new Map([[1,{id:1,nick:'alice'}],[2,{id:2,nick:'#environment'}]]), materialIdToName:new Map([[1,'STONE']]), entityIdToName:new Map() };
  return { db, cfg:{defaultLimit:2,coreProtectTiles:{tileSize:16}}, meta:{worlds:[{id:1,world:'world'}]}, status:{}, getDb:()=>db,getMaps:()=>maps,getMeta:()=>({worlds:[],users:[],materials:[],actions:[]}),refreshMeta(){},close:()=>db.close() };
}
function insert(s, table, time, x, z, user=1) { s.db.prepare(`INSERT INTO co_${table}(time,user,wid,x,y,z,type,action) VALUES(?,?,1,?,64,?,1,0)`).run(time,user,x,z); }
async function appFor(s) { return buildApp({store:s,cfg:s.cfg,rootDir:'no-static-test-root'}); }

test('plan/query/aggregate share filters, snapshots, and all sources', async () => {
  const s=store(); insert(s,'block',10,0,0); insert(s,'container',10,1,0); insert(s,'item',10,2,0); insert(s,'block',11,3,0,2); const app=await appFor(s);
  try { const plan=(await app.inject('/api/query-plan?users=!%23*')).json(); assert.equal(plan.strategy,'overview-and-detail'); assert.equal(plan.countAtLeast,3); const snap=encodeURIComponent(JSON.stringify(plan.snapshot)); insert(s,'block',12,4,0); const query=(await app.inject(`/api/query?users=!%23*&pageSize=10&snapshot=${snap}`)).json(); assert.equal(query.count,3); assert.equal(new Set(query.events.map(e=>e.src)).size,3); const aggregate=(await app.inject(`/api/aggregate?users=!%23*&snapshot=${snap}`)).json(); assert.equal(aggregate.total,3); assert.equal(aggregate.chunks.reduce((n,c)=>n+c.cnt,0),3); } finally { await app.close(); s.close(); }
});

test('keyset ordering preserves same-timestamp source/row identities and hasMore', async () => {
  const s=store(); for(let i=0;i<5;i++) insert(s,'block',100,i,0); insert(s,'container',100,9,0); const app=await appFor(s);
  try { let url='/api/query?pageSize=2', ids=[]; for(let page=0;page<4;page++){const body=(await app.inject(url)).json(); ids.push(...body.events.map(e=>`${e.src}:${e.rowid_src}`)); if(!body.hasMore){assert.equal(body.nextCursor,null);break;} url=`/api/query?pageSize=2&snapshot=${encodeURIComponent(JSON.stringify(body.snapshot))}&cursor=${encodeURIComponent(body.nextCursor)}`;} assert.equal(ids.length,6); assert.equal(new Set(ids).size,6); const invalid=await app.inject('/api/query?cursor=nope'); assert.equal(invalid.statusCode,400); } finally { await app.close();s.close(); }
});

test('half-open adjacent transport tiles do not duplicate boundaries and use floor for negatives', async () => {
  const s=store(); insert(s,'block',1,-1,-1); insert(s,'block',2,0,0); insert(s,'block',3,16,0); const app=await appFor(s);
  try { const left=(await app.inject('/api/query?xMin=0&xMaxExclusive=16&zMin=0&zMaxExclusive=16&pageSize=10')).json(); const right=(await app.inject('/api/query?xMin=16&xMaxExclusive=32&zMin=0&zMaxExclusive=16&pageSize=10')).json(); assert.deepEqual(left.events.map(e=>e.x),[0]); assert.deepEqual(right.events.map(e=>e.x),[16]); const overview=(await app.inject('/api/aggregate?tileSize=16')).json(); assert.ok(overview.occupiedTiles.some(t=>t.tx===-1&&t.tz===-1)); } finally {await app.close();s.close();}
});