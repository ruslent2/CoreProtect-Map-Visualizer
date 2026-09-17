import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildApp } from '../src/index.js';
import { ACTIONS } from '../src/db.js';

function store() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE co_world(id INTEGER PRIMARY KEY,world TEXT);CREATE TABLE co_user(id INTEGER PRIMARY KEY,user TEXT,uuid TEXT);CREATE TABLE co_material_map(id INTEGER PRIMARY KEY,material TEXT);CREATE TABLE co_entity_map(id INTEGER PRIMARY KEY,entity TEXT);${['block','container','item'].map(name=>`CREATE TABLE co_${name}(time INTEGER,user INTEGER,wid INTEGER,x INTEGER,y INTEGER,z INTEGER,type INTEGER,action INTEGER,amount INTEGER DEFAULT 1,rolled_back INTEGER DEFAULT 0);`).join('')}`);
  db.prepare('INSERT INTO co_world VALUES(1,?)').run('world'); db.prepare('INSERT INTO co_user VALUES(1,?,?)').run('alice','a'); db.prepare('INSERT INTO co_user VALUES(2,?,?)').run('#environment','e'); db.prepare('INSERT INTO co_material_map VALUES(1,?)').run('STONE'); db.prepare('INSERT INTO co_material_map VALUES(2,?)').run('minecraft:grass_block');
  const maps = { worldNameToId:new Map([['world',1]]), userNameToId:new Map([['alice',1],['#environment',2]]), userIdToUser:new Map([[1,{id:1,nick:'alice'}],[2,{id:2,nick:'#environment'}]]), materialIdToName:new Map([[1,'STONE'],[2,'minecraft:grass_block']]), entityIdToName:new Map() };
  return { db, cfg:{defaultLimit:2,materialNamePrefixesToStrip:['minecraft:'],coreProtectTiles:{tileSize:16}}, meta:{worlds:[{id:1,world:'world'}]}, status:{}, getDb:()=>db,getMaps:()=>maps,getMeta:()=>({worlds:[],users:[],materials:[],actions:[]}),refreshMeta(){},close:()=>db.close() };
}
function insert(s, table, time, x, z, user=1, type=1, action=0) { s.db.prepare(`INSERT INTO co_${table}(time,user,wid,x,y,z,type,action) VALUES(?,?,1,?,64,?,?,?)`).run(time,user,x,z,type,action); }
async function appFor(s) { return buildApp({store:s,cfg:s.cfg,rootDir:'no-static-test-root'}); }

test('item action filters map to CoreProtect 23.2 codes', async () => {
  const s=store();
  for (let action=2; action<=12; action++) insert(s,'item',100+action,action,0,1,1,action);
  const app=await appFor(s);
  const ids=['item_drop','item_pickup','ender_take','ender_put','item_throw','item_shoot','item_break','craft_put','craft_take','trade_give','trade_receive'];
  try {
    for (const [index,id] of ids.entries()) {
      const body=(await app.inject(`/api/query?actions=${id}&pageSize=20`)).json();
      assert.deepEqual(body.events.map(event=>event.action),[index+2]);
    }
    assert.equal(ACTIONS.some(action=>action.id==='other'),false);
    assert.deepEqual(ACTIONS.find(action=>action.id==='craft_take'),{id:'craft_take',label:'Крафт: забрано',src:'item',action:10});
  } finally { await app.close();s.close(); }
});

test('plan/query/aggregate share filters, snapshots, players, and all sources', async () => {
  const s=store(); insert(s,'block',10,0,0); insert(s,'container',10,1,0); insert(s,'item',10,2,0); insert(s,'block',11,3,0,2); const app=await appFor(s);
  try { const plan=(await app.inject('/api/query-plan?users=!%23*')).json(); assert.equal(plan.strategy,'overview-and-detail'); assert.equal(plan.countAtLeast,3); const snap=encodeURIComponent(JSON.stringify(plan.snapshot)); insert(s,'block',12,4,0); const query=(await app.inject(`/api/query?users=!%23*&pageSize=10&snapshot=${snap}`)).json(); assert.equal(query.count,3); assert.equal(new Set(query.events.map(e=>e.src)).size,3); const aggregate=(await app.inject(`/api/aggregate?users=!%23*&snapshot=${snap}`)).json(); assert.equal(aggregate.total,3); assert.equal(aggregate.chunks.reduce((n,c)=>n+c.cnt,0),3); assert.deepEqual(aggregate.players,[{nick:'alice',uuid:'a'}]); } finally { await app.close(); s.close(); }
});

test('keyset ordering preserves same-timestamp source/row identities and hasMore', async () => {
  const s=store(); for(let i=0;i<5;i++) insert(s,'block',100,i,0); insert(s,'container',100,9,0); const app=await appFor(s);
  try { let url='/api/query?pageSize=2', ids=[]; for(let page=0;page<4;page++){const body=(await app.inject(url)).json(); ids.push(...body.events.map(e=>`${e.src}:${e.rowid_src}`)); if(!body.hasMore){assert.equal(body.nextCursor,null);break;} url=`/api/query?pageSize=2&snapshot=${encodeURIComponent(JSON.stringify(body.snapshot))}&cursor=${encodeURIComponent(body.nextCursor)}`;} assert.equal(ids.length,6); assert.equal(new Set(ids).size,6); const invalid=await app.inject('/api/query?cursor=nope'); assert.equal(invalid.statusCode,400); } finally { await app.close();s.close(); }
});

test('half-open adjacent transport tiles do not duplicate boundaries and use floor for negatives', async () => {
  const s=store(); insert(s,'block',1,-1,-1); insert(s,'block',2,0,0); insert(s,'block',3,16,0); const app=await appFor(s);
  try { const left=(await app.inject('/api/query?xMin=0&xMaxExclusive=16&zMin=0&zMaxExclusive=16&pageSize=10')).json(); const right=(await app.inject('/api/query?xMin=16&xMaxExclusive=32&zMin=0&zMaxExclusive=16&pageSize=10')).json(); assert.deepEqual(left.events.map(e=>e.x),[0]); assert.deepEqual(right.events.map(e=>e.x),[16]); const overview=(await app.inject('/api/aggregate?tileSize=16')).json(); assert.ok(overview.occupiedTiles.some(t=>t.tx===-1&&t.tz===-1)); } finally {await app.close();s.close();}
});

test('nearby events include every player and list the newest activity first', async () => {
  const s=store(); insert(s,'block',100,0,0,1); insert(s,'container',102,1,0,2); insert(s,'item',101,2,0,1); const app=await appFor(s);
  try { const body=(await app.inject('/api/event/block/1')).json(); assert.deepEqual(body.nearby.map(event=>event.time),[102,101,100]); assert.deepEqual(body.nearby.map(event=>event.nick),['#environment','alice','alice']); } finally { await app.close();s.close(); }
});

test('minecraft namespace events remain visible with their namespace removed', async () => {
  const s=store(); insert(s,'block',100,0,0,1,2); insert(s,'container',101,1,0); const app=await appFor(s);
  try { const query=(await app.inject('/api/query?pageSize=10')).json(); const aggregate=(await app.inject('/api/aggregate')).json(); const event=(await app.inject('/api/event/block/1')).json(); assert.equal(query.count,2); assert.equal(query.events.find(row=>row.src==='block').material,'grass_block'); assert.equal(aggregate.total,2); assert.equal(event.event.material,'grass_block'); } finally { await app.close();s.close(); }

  const unfiltered=store(); unfiltered.cfg.materialNamePrefixesToStrip=[]; insert(unfiltered,'block',100,0,0,1,2); const unfilteredApp=await appFor(unfiltered);
  try { const query=(await unfilteredApp.inject('/api/query?pageSize=10')).json(); assert.equal(query.count,1); assert.equal(query.events[0].material,'minecraft:grass_block'); } finally { await unfilteredApp.close();unfiltered.close(); }
});