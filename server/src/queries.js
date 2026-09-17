import { toStr } from './db.js';
import { stripMaterialNamePrefix } from './config.js';

const MAX = 200000;
const DEFAULT_LIMIT = 50000;
const SOURCES = ['block', 'container', 'item'];
const RANK = { block: 0, container: 1, item: 2 };

// Сирі коди дій CoreProtect 23.2; джерело є частиною ідентифікатора дії.
const ACTIONS = {
  break: ['block', 0],
  place: ['block', 1],
  interact: ['block', 2],
  entity_kill: ['block', 3],
  container_take: ['container', 0],
  container_put: ['container', 1],
  item_drop: ['item', 2],
  item_pickup: ['item', 3],
  ender_take: ['item', 4],
  ender_put: ['item', 5],
  item_throw: ['item', 6],
  item_shoot: ['item', 7],
  item_break: ['item', 8],
  craft_put: ['item', 9],
  craft_take: ['item', 10],
  trade_give: ['item', 11],
  trade_receive: ['item', 12],
};

const bad = message => Object.assign(new Error(message), { statusCode: 400 });

function asInteger(value, name) {
  if (Array.isArray(value)) {
    throw bad(`${name} must be a single integer`);
  }

  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw bad(`${name} must be a finite integer`);
  }

  return number;
}

// Нормалізує та перевіряє параметри фільтра запиту.
export function parseFilters(query) {
  const q = { ...query };

  for (const key of ['users', 'materials', 'actions']) {
    if (q[key] != null && q[key] !== '') {
      q[key] = (Array.isArray(q[key]) ? q[key] : [q[key]])
        .flatMap(v => String(v).split(/[\n,]/))
        .map(v => v.trim())
        .filter(Boolean);
    }
  }

  for (const key of [
    'x1', 'x2', 'z1', 'z2', 'xMin', 'xMaxExclusive', 'zMin',
    'zMaxExclusive', 'y', 'tFrom', 'tTo', 'limit', 'pageSize', 'tileSize',
  ]) {
    if (q[key] != null && q[key] !== '') {
      q[key] = asInteger(q[key], key);
    }
  }

  if (q.x1 != null && q.x2 != null && q.x1 > q.x2) {
    throw bad('x1 must not be greater than x2');
  }
  if (q.z1 != null && q.z2 != null && q.z1 > q.z2) {
    throw bad('z1 must not be greater than z2');
  }
  if (q.tFrom != null && q.tTo != null && q.tFrom > q.tTo) {
    throw bad('tFrom must not be greater than tTo');
  }

  const tileBounds = ['xMin', 'xMaxExclusive', 'zMin', 'zMaxExclusive'];
  if (tileBounds.some(key => q[key] != null) && !tileBounds.every(key => q[key] != null)) {
    throw bad('tile bounds require xMin, xMaxExclusive, zMin, and zMaxExclusive');
  }
  if (q.xMin != null && (q.xMin >= q.xMaxExclusive || q.zMin >= q.zMaxExclusive)) {
    throw bad('exclusive tile bounds must have positive area');
  }

  for (const key of ['limit', 'pageSize']) {
    if (q[key] != null) {
      q[key] = Math.min(MAX, Math.max(1, q[key]));
    }
  }
  if (q.tileSize != null && q.tileSize < 1) {
    throw bad('tileSize must be positive');
  }

  return q;
}

// Перетворює шаблон * і ? на регулярний вираз.
function glob(pattern, sensitive) {
  return new RegExp(
    `^${[...pattern]
      .map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$+.()|{}[\]]/g, '\\$&'))
      .join('')}$`,
    sensitive ? '' : 'i',
  );
}

function resolve(items, patterns, field) {
  const rules = patterns.map(raw => {
    let pattern = raw;
    let include = true;

    if (pattern.startsWith('!')) {
      include = false;
      pattern = pattern.slice(1);
    }

    const sensitive = pattern.startsWith('(?i)');
    if (sensitive) {
      pattern = pattern.slice(4);
    }

    return { include, regex: glob(pattern, sensitive) };
  });

  const hasInclude = rules.some(rule => rule.include);
  return items
    .filter(item => {
      let result = !hasInclude;
      for (const rule of rules) {
        if (rule.regex.test(item[field] ?? '')) {
          result = rule.include;
        }
      }
      return result;
    })
    .map(item => item.id);
}

// Зберігає верхні межі rowid, щоб забезпечити сталий знімок результатів.
export function getSourceSnapshot(store) {
  const db = store.getDb();
  return Object.fromEntries(
    SOURCES.map(src => [
      src,
      Number(db.prepare(`SELECT COALESCE(MAX(rowid), 0) n FROM co_${src}`).get().n),
    ]),
  );
}

export function parseSnapshot(value) {
  if (value == null || value === '') {
    return null;
  }
  if (Array.isArray(value)) {
    throw bad('snapshot must be a single JSON object');
  }

  let snapshot;
  try {
    snapshot = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw bad('snapshot must be valid JSON');
  }

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).length !== 3) {
    throw bad('snapshot must contain block, container, and item');
  }

  for (const source of SOURCES) {
    if (!Object.hasOwn(snapshot, source) || !Number.isSafeInteger(snapshot[source]) || snapshot[source] < 0) {
      throw bad('snapshot must contain non-negative block, container, and item');
    }
  }

  return Object.fromEntries(SOURCES.map(source => [source, snapshot[source]]));
}

function pairs(map) {
  return map ? [...map].map(([id, name]) => ({ id, name })) : [];
}

// Формує плани SQL-запитів для усіх активних таблиць CoreProtect.
function plans(store, q, snapshot) {
  const maps = store.getMaps();
  let wid = q.world ? maps.worldNameToId.get(String(q.world).trim()) ?? null : null;

  if (wid == null && store.meta?.worlds?.length) {
    wid = store.meta.worlds[0].id;
  }

  const active = new Set(SOURCES);
  const include = Object.fromEntries(SOURCES.map(s => [s, new Set()]));
  const exclude = Object.fromEntries(SOURCES.map(s => [s, new Set()]));

  if (q.actions?.length) {
    if (q.actionsExcl) {
      for (const action of q.actions) {
        const mapping = ACTIONS[action];
        if (mapping) {
          exclude[mapping[0]].add(mapping[1]);
        }
      }
    } else {
      active.clear();
      for (const action of q.actions) {
        const mapping = ACTIONS[action];
        if (mapping) {
          active.add(mapping[0]);
          include[mapping[0]].add(mapping[1]);
        }
      }
    }
  }

  let userIds = null;
  if (q.users?.length) {
    const users = maps.userIdToUser
      ? [...maps.userIdToUser.values()]
      : [...maps.userNameToId.entries()].map(([nick, id]) => ({ id, nick }));
    userIds = resolve(users, q.users, 'nick');
    if (!userIds.length) {
      return [];
    }
  }

  let materialIds = null;
  let entityIds = null;
  if (q.materials?.length) {
    materialIds = resolve(pairs(maps.materialIdToName), q.materials, 'name');
    entityIds = resolve(pairs(maps.entityIdToName), q.materials, 'name');
    if (!q.materialsExcl && !materialIds.length && !entityIds.length) {
      return [];
    }
  }

  const common = [];
  const params = {};

  if (wid != null) {
    common.push('wid=@wid');
    params.wid = wid;
  }
  if (q.x1 != null && q.x2 != null && q.z1 != null && q.z2 != null) {
    common.push('x BETWEEN @x1 AND @x2 AND z BETWEEN @z1 AND @z2');
    Object.assign(params, { x1: q.x1, x2: q.x2, z1: q.z1, z2: q.z2 });
  }
  if (q.xMin != null) {
    common.push('x>=@xMin AND x<@xMaxExclusive AND z>=@zMin AND z<@zMaxExclusive');
    Object.assign(params, {
      xMin: q.xMin,
      xMaxExclusive: q.xMaxExclusive,
      zMin: q.zMin,
      zMaxExclusive: q.zMaxExclusive,
    });
  }
  if (q.y != null) {
    common.push('y=@y');
    params.y = q.y;
  }
  if (q.tFrom != null) {
    common.push('time>=@tFrom');
    params.tFrom = q.tFrom;
  }
  if (q.tTo != null) {
    common.push('time<=@tTo');
    params.tTo = q.tTo;
  }
  if (userIds) {
    common.push(`user IN (${userIds.join(',')})`);
  }

  return [...active].flatMap(src => {
    const where = [...common, `rowid<=${snapshot[src]}`];
    const actionIds = q.actionsExcl ? exclude[src] : include[src];

    if (q.actions?.length && actionIds.size) {
      where.push(`action ${q.actionsExcl ? 'NOT IN' : 'IN'} (${[...actionIds].join(',')})`);
    }
    if (q.materials?.length) {
      const ids = src === 'block' ? [...new Set([...materialIds, ...entityIds])] : materialIds;
      if (ids.length) {
        where.push(`type ${q.materialsExcl ? 'NOT IN' : 'IN'} (${ids.join(',')})`);
      } else if (!q.materialsExcl) {
        return [];
      }
    }

    return [{ src, table: `co_${src}`, where: where.join(' AND '), params }];
  });
}

function qualify(where, alias) {
  return where.replace(
    /(?<![.@])\b(user|wid|x|y|z|time|action|type|rowid)\b/g,
    `${alias}.$1`,
  );
}

function allParams(tablePlans) {
  return Object.assign({}, ...tablePlans.map(plan => plan.params));
}

function detailSelect(plan) {
  const a = plan.src === 'block' ? 'b' : plan.src === 'container' ? 'c' : 'i';
  const material = plan.src === 'block'
    ? 'CASE WHEN b.action=3 THEN CAST(e.entity AS TEXT) ELSE CAST(m.material AS TEXT) END'
    : 'CAST(m.material AS TEXT)';

  return `SELECT '${plan.src}' src,${RANK[plan.src]} source_rank,${a}.rowid rowid_src,${a}.time,CAST(u.user AS TEXT) nick,CAST(u.uuid AS TEXT) uuid,CAST(w.world AS TEXT) world,${a}.x,${a}.y,${a}.z,${material} material,${plan.src === 'block' ? 'NULL' : `${a}.amount`} amount,${a}.action,${a}.rolled_back FROM ${plan.table} ${a} LEFT JOIN co_user u ON u.id=${a}.user LEFT JOIN co_world w ON w.id=${a}.wid LEFT JOIN co_material_map m ON m.id=${a}.type ${plan.src === 'block' ? 'LEFT JOIN co_entity_map e ON e.id=b.type' : ''} WHERE ${qualify(plan.where, a)}`;
}

function normalize(rows, prefixes = []) {
  return rows.map(row => {
    row.nick = toStr(row.nick);
    row.uuid = toStr(row.uuid);
    row.world = toStr(row.world);
    row.material = stripMaterialNamePrefix(toStr(row.material), prefixes);
    delete row.source_rank;
    return row;
  });
}

// Кодує порядок запису для курсорної пагінації.
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    time: row.time,
    sourceRank: RANK[row.src],
    rowid: row.rowid_src,
  })).toString('base64url');
}

export function parseCursor(value) {
  if (value == null || value === '') {
    return null;
  }
  if (Array.isArray(value)) {
    throw bad('cursor must be a single value');
  }

  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    throw bad('cursor is malformed');
  }

  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || Object.keys(cursor).length !== 3 || !Number.isSafeInteger(cursor.time) || !Number.isInteger(cursor.sourceRank) || cursor.sourceRank < 0 || cursor.sourceRank > 2 || !Number.isSafeInteger(cursor.rowid) || cursor.rowid < 1) {
    throw bad('cursor is malformed');
  }

  return cursor;
}

// Виконує об'єднаний запит подій із стабільною курсорною пагінацією.
export function queryEvents(store, q, suppliedSnapshot = null, cursor = null, pageSize = null) {
  const snapshot = suppliedSnapshot ?? getSourceSnapshot(store);
  const tablePlans = plans(store, q, snapshot);
  const limit = Math.min(
    MAX,
    Math.max(1, pageSize ?? q.pageSize ?? q.limit ?? store.cfg.defaultLimit ?? DEFAULT_LIMIT),
  );

  if (!tablePlans.length) {
    return { rows: [], elapsed: 0, hasMore: false, truncated: false, snapshot };
  }

  const params = allParams(tablePlans);
  let keyset = '';
  if (cursor) {
    keyset = 'WHERE time<@ct OR (time=@ct AND (source_rank>@cs OR (source_rank=@cs AND rowid_src<@cr)))';
    Object.assign(params, { ct: cursor.time, cs: cursor.sourceRank, cr: cursor.rowid });
  }

  const start = performance.now();
  const fetched = store.getDb().prepare(
    `SELECT * FROM (${tablePlans.map(detailSelect).join(' UNION ALL ')}) ${keyset} ORDER BY time DESC,source_rank ASC,rowid_src DESC LIMIT ${limit + 1}`,
  ).all(params);
  const hasMore = fetched.length > limit;

  return {
    rows: normalize(fetched.slice(0, limit), store.cfg.materialNamePrefixesToStrip),
    elapsed: Math.round(performance.now() - start),
    hasMore,
    truncated: hasMore,
    snapshot,
  };
}

export function bboxOf(rows) {
  if (!rows.length) {
    return null;
  }

  let x1 = Infinity;
  let x2 = -Infinity;
  let z1 = Infinity;
  let z2 = -Infinity;

  for (const row of rows) {
    x1 = Math.min(x1, row.x);
    x2 = Math.max(x2, row.x);
    z1 = Math.min(z1, row.z);
    z2 = Math.max(z2, row.z);
  }

  return { x1, x2, z1, z2 };
}

export function bboxOfChunks(chunks) {
  return bboxOf(chunks.flatMap(chunk => [
    { x: chunk.cx * 16, z: chunk.cz * 16 },
    { x: chunk.cx * 16 + 15, z: chunk.cz * 16 + 15 },
  ]));
}

// Визначає стратегію: повна вибірка або огляд із деталізацією.
export function queryPlan(store, q, snapshot = null) {
  const threshold = Math.min(MAX, Math.max(1, store.cfg.defaultLimit ?? DEFAULT_LIMIT));
  const result = queryEvents(store, q, snapshot, null, threshold);
  const totalExact = !result.hasMore;

  return {
    strategy: totalExact ? 'all' : 'overview-and-detail',
    threshold,
    countAtLeast: totalExact ? result.rows.length : threshold + 1,
    totalExact,
    ...(totalExact ? { total: result.rows.length, bounds: bboxOf(result.rows) } : { bounds: null }),
    snapshot: result.snapshot,
    elapsedMs: result.elapsed,
  };
}

// Агрегує події за чанками, плитками та гравцями для карти.
export function aggregateChunks(store, q, suppliedSnapshot = null, tileSize = 256) {
  const snapshot = suppliedSnapshot ?? getSourceSnapshot(store);
  const tablePlans = plans(store, q, snapshot);

  if (!tablePlans.length) {
    return {
      chunks: [], occupiedTiles: [], players: [], total: 0,
      temporal: null, elapsed: 0, elapsedMs: 0, snapshot,
    };
  }

  const params = { ...allParams(tablePlans), tileSize };
  const source = tablePlans
    .map(plan => `SELECT '${plan.src}' src,${RANK[plan.src]} source_rank,user,action,x,z,time FROM ${plan.table} WHERE ${plan.where}`)
    .join(' UNION ALL ');
  const db = store.getDb();
  const start = performance.now();

  const chunks = db.prepare(`WITH events AS (${source}), totals AS (SELECT (x>>4) cx,(z>>4) cz,COUNT(*) cnt,COUNT(DISTINCT user) users,MIN(time) tmin,MAX(time) tmax FROM events GROUP BY cx,cz), ranked AS (SELECT cx,cz,user,src,action,COUNT(*) cnt,ROW_NUMBER() OVER (PARTITION BY cx,cz ORDER BY COUNT(*) DESC,source_rank ASC,user ASC,action ASC) rn FROM (SELECT (x>>4) cx,(z>>4) cz,user,src,source_rank,action FROM events) GROUP BY cx,cz,user,src,source_rank,action) SELECT totals.*,ranked.src,ranked.action,CAST(u.user AS TEXT) nick,CAST(u.uuid AS TEXT) uuid FROM totals LEFT JOIN ranked ON ranked.cx=totals.cx AND ranked.cz=totals.cz AND ranked.rn=1 LEFT JOIN co_user u ON u.id=ranked.user`)
    .all(params)
    .map(row => ({
      cx: row.cx,
      cz: row.cz,
      cnt: row.cnt,
      users: row.users,
      tmin: row.tmin,
      tmax: row.tmax,
      dominant: row.src
        ? { src: row.src, action: row.action, nick: toStr(row.nick), uuid: toStr(row.uuid) }
        : null,
    }));

  const occupiedTiles = db.prepare(`WITH events AS (${source}) SELECT CAST(FLOOR(x*1.0/@tileSize) AS INTEGER) tx,CAST(FLOOR(z*1.0/@tileSize) AS INTEGER) tz,COUNT(*) cnt,MIN(time) tmin,MAX(time) tmax FROM events GROUP BY tx,tz ORDER BY tz,tx`).all(params);
  const players = db.prepare(`WITH events AS (${source}) SELECT CAST(u.user AS TEXT) nick,CAST(u.uuid AS TEXT) uuid FROM (SELECT DISTINCT user FROM events) filtered_users LEFT JOIN co_user u ON u.id=filtered_users.user ORDER BY nick COLLATE NOCASE`)
    .all(params)
    .map(player => ({ nick: toStr(player.nick), uuid: toStr(player.uuid) }));
  const summary = db.prepare(`WITH events AS (${source}) SELECT COUNT(*) total,MIN(time) tmin,MAX(time) tmax,COUNT(DISTINCT user) users FROM events`).get(params);
  const elapsed = Math.round(performance.now() - start);

  return {
    chunks,
    occupiedTiles,
    players,
    total: summary.total,
    temporal: summary.total
      ? { tmin: summary.tmin, tmax: summary.tmax, users: summary.users }
      : null,
    elapsed,
    elapsedMs: elapsed,
    snapshot,
  };
}

// Повертає одну подію за таблицею-джерелом і rowid.
export function getEvent(store, src, rowid) {
  const table = src === 'entity' ? 'block' : src;
  const rid = Number(rowid);

  if (!SOURCES.includes(table) || !Number.isSafeInteger(rid) || rid < 1) {
    return null;
  }

  const a = table === 'block' ? 'b' : table === 'container' ? 'c' : 'i';
  const material = table === 'block'
    ? 'CASE WHEN b.action=3 THEN CAST(e.entity AS TEXT) ELSE CAST(m.material AS TEXT) END'
    : 'CAST(m.material AS TEXT)';
  const row = store.getDb().prepare(`SELECT '${table}' src,${a}.rowid rowid_src,${a}.time,${a}.user user_id,CAST(u.user AS TEXT) nick,CAST(u.uuid AS TEXT) uuid,CAST(w.world AS TEXT) world,${a}.wid,${a}.x,${a}.y,${a}.z,${material} material,${table === 'block' ? 'NULL' : `${a}.amount`} amount,${a}.action,${a}.rolled_back FROM co_${table} ${a} LEFT JOIN co_user u ON u.id=${a}.user LEFT JOIN co_world w ON w.id=${a}.wid LEFT JOIN co_material_map m ON m.id=${a}.type ${table === 'block' ? 'LEFT JOIN co_entity_map e ON e.id=b.type' : ''} WHERE ${a}.rowid=?`).get(rid);

  return row ? {
    ...row,
    nick: toStr(row.nick),
    uuid: toStr(row.uuid),
    world: toStr(row.world),
    material: stripMaterialNamePrefix(toStr(row.material), store.cfg.materialNamePrefixesToStrip),
  } : null;
}

// Recent local activity from every player helps trace item transfers and interactions.
export function nearbyEvents(store, event, radius = 16) {
  if (!event || event.wid == null) {
    return [];
  }

  const p = {
    wid: event.wid,
    x1: event.x - radius,
    x2: event.x + radius,
    z1: event.z - radius,
    z2: event.z + radius,
    tFrom: event.time - 3600,
    tTo: event.time + 3600,
  };
  const parts = SOURCES.map(src => {
    const a = src === 'block' ? 'b' : src === 'container' ? 'c' : 'i';
    const material = src === 'block'
      ? 'CASE WHEN b.action=3 THEN CAST(e.entity AS TEXT) ELSE CAST(m.material AS TEXT) END'
      : 'CAST(m.material AS TEXT)';

    return `SELECT '${src}' src,${a}.rowid rowid_src,${a}.time,CAST(u.user AS TEXT) nick,${material} material,${a}.action,${a}.x,${a}.y,${a}.z FROM co_${src} ${a} LEFT JOIN co_user u ON u.id=${a}.user LEFT JOIN co_material_map m ON m.id=${a}.type ${src === 'block' ? 'LEFT JOIN co_entity_map e ON e.id=b.type' : ''} WHERE ${a}.wid=@wid AND ${a}.x BETWEEN @x1 AND @x2 AND ${a}.z BETWEEN @z1 AND @z2 AND ${a}.time BETWEEN @tFrom AND @tTo`;
  });

  return store.getDb().prepare(`SELECT * FROM (${parts.join(' UNION ALL ')}) ORDER BY time DESC,rowid_src DESC LIMIT 50`)
    .all(p)
    .map(row => ({
      ...row,
      nick: toStr(row.nick),
      material: stripMaterialNamePrefix(toStr(row.material), store.cfg.materialNamePrefixesToStrip),
    }));
}
