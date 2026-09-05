// Построение запросов к оригинальной базе данных CoreProtect
import { toStr } from './db.js';

// Маппинг действий на таблицы и коды действий CoreProtect
// В CoreProtect:
// co_block: 0=break, 1=place, 2=interact, 3=kill/other
// co_container: 0=take, 1=put
// co_item: 0=drop, 1=pickup, 2=throw (и другие)
const ACTION_MAP = {
  break:          { src: 'block',     action: 0 },
  place:          { src: 'block',     action: 1 },
  interact:       { src: 'block',     action: 2 },
  other:          { src: 'block',     action: 3 },
  container_take: { src: 'container', action: 0 },
  container_put:  { src: 'container', action: 1 },
  item_drop:      { src: 'item',      action: 0 },
  item_pickup:    { src: 'item',      action: 1 },
  item_throw:     { src: 'item',      action: 2 },
  entity_kill:    { src: 'block',     action: 3 }, // В CoreProtect убийства сущностей пишутся в co_block с action=3
};

export function parseFilters(query) {
  const q = { ...query };
  for (const k of ['users', 'materials', 'actions']) {
    if (typeof q[k] === 'string' && q[k].trim()) {
      q[k] = q[k].split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    }
  }
  return q;
}

function globToRegExp(pattern, caseSensitive) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[\\^$+.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i');
}

function resolveUserIds(users, patterns) {
  const rules = patterns.map(raw => {
    let pattern = raw;
    let include = true;
    if (pattern.startsWith('!')) {
      include = false;
      pattern = pattern.slice(1);
    }
    let caseSensitive = false;
    if (pattern.startsWith('(?i)')) {
      caseSensitive = true;
      pattern = pattern.slice(4);
    }
    return { include, regex: globToRegExp(pattern, caseSensitive) };
  });
  const hasIncludeRule = rules.some(r => r.include);
  return users.filter(user => {
    let matched = !hasIncludeRule;
    for (const rule of rules) {
      if (rule.regex.test(user.nick ?? '')) matched = rule.include;
    }
    return matched;
  }).map(user => user.id);
}

function resolvePatternIds(nameById, patterns) {
  const names = Array.from(nameById, ([id, name]) => ({ id, name }));
  const rules = patterns.map(raw => {
    let pattern = raw;
    let include = true;
    if (pattern.startsWith('!')) {
      include = false;
      pattern = pattern.slice(1);
    }
    const caseSensitive = pattern.startsWith('(?i)');
    if (caseSensitive) pattern = pattern.slice(4);
    return { include, regex: globToRegExp(pattern, caseSensitive) };
  });
  const hasIncludeRule = rules.some(r => r.include);
  return names.filter(({ name }) => {
    let matched = !hasIncludeRule;
    for (const rule of rules) if (rule.regex.test(name ?? '')) matched = rule.include;
    return matched;
  }).map(({ id }) => id);
}

// Построение планов запроса для каждой таблицы событий
function buildTablePlans(store, q) {
  const maps = store.getMaps();

  // Определяем wid
  let wid = null;
  if (q.world) {
    wid = maps.worldNameToId.get(q.world.trim()) ?? null;
  }
  if (wid == null && store.meta?.worlds?.length) {
    wid = store.meta.worlds[0].id;
  }

  // Определяем фильтрацию по действиям / источникам
  const allSources = ['block', 'container', 'item'];
  let activeSources = new Set(allSources);
  const sourceActions = {
    block: new Set(),
    container: new Set(),
    item: new Set(),
  };

  if (q.actions?.length) {
    if (q.actionsExcl) {
      // Исключение: все источники активны, но некоторые действия исключаются
      const excludedActions = {
        block: new Set(),
        container: new Set(),
        item: new Set(),
      };
      for (const a of q.actions) {
        const m = ACTION_MAP[a];
        if (m) excludedActions[m.src].add(m.action);
      }
      sourceActions._excluded = excludedActions;
    } else {
      // Включение: активны только те источники, у которых выбрано действие
      activeSources.clear();
      for (const a of q.actions) {
        const m = ACTION_MAP[a];
        if (m) {
          activeSources.add(m.src);
          sourceActions[m.src].add(m.action);
        }
      }
    }
  }

  // Маппинг пользователей по glob-шаблонам: последнее совпавшее правило побеждает.
  let userIds = null;
  if (q.users?.length) {
    const knownUsers = maps.userIdToUser
      ? Array.from(maps.userIdToUser.values())
      : Array.from(maps.userNameToId.entries()).map(([nick, id]) => ({ nick, id }));
    userIds = resolveUserIds(knownUsers, q.users);
    if (userIds.length === 0) {
      return { empty: true };
    }
  }

  // Маппинг материалов в ID
  let materialIds = null;
  let entityIds = null;
  if (q.materials?.length) {
    materialIds = resolvePatternIds(maps.materialIdToName, q.materials);
    entityIds = resolvePatternIds(maps.entityIdToName, q.materials);
    if (materialIds.length === 0 && entityIds.length === 0 && !q.materialsExcl) {
      return { empty: true };
    }
  }

  // Строим фильтры
  const commonParams = {};
  const commonConds = [];

  if (wid != null) {
    commonConds.push('wid = @wid');
    commonParams.wid = wid;
  }

  if (q.x1 != null && q.x2 != null && q.z1 != null && q.z2 != null) {
    commonConds.push('x BETWEEN @x1 AND @x2 AND z BETWEEN @z1 AND @z2');
    commonParams.x1 = +q.x1; commonParams.x2 = +q.x2;
    commonParams.z1 = +q.z1; commonParams.z2 = +q.z2;
  }

  if (q.y != null && q.y !== '') {
    commonConds.push('y = @y');
    commonParams.y = +q.y;
  }

  if (q.tFrom != null) {
    commonConds.push('time >= @tFrom');
    commonParams.tFrom = +q.tFrom;
  }

  if (q.tTo != null) {
    commonConds.push('time <= @tTo');
    commonParams.tTo = +q.tTo;
  }

  if (userIds && userIds.length > 0) {
    commonConds.push(`user IN (${userIds.join(',')})`);
  }

  const plans = [];

  for (const src of activeSources) {
    const conds = [...commonConds];
    const params = { ...commonParams };

    // Фильтр по действиям
    if (q.actions?.length) {
      if (q.actionsExcl) {
        const excl = sourceActions._excluded?.[src];
        if (excl && excl.size > 0) {
          conds.push(`action NOT IN (${Array.from(excl).join(',')})`);
        }
      } else {
        const inc = sourceActions[src];
        if (inc && inc.size > 0) {
          conds.push(`action IN (${Array.from(inc).join(',')})`);
        }
      }
    }

    // Фильтр по материалам
    if (q.materials?.length) {
      if (src === 'block') {
        const allTypeIds = Array.from(new Set([...materialIds, ...entityIds]));
        if (allTypeIds.length > 0) {
          const op = q.materialsExcl ? 'NOT IN' : 'IN';
          conds.push(`type ${op} (${allTypeIds.join(',')})`);
        } else if (!q.materialsExcl) {
          continue; // Ничего не может совпасть
        }
      } else {
        if (materialIds && materialIds.length > 0) {
          const op = q.materialsExcl ? 'NOT IN' : 'IN';
          conds.push(`type ${op} (${materialIds.join(',')})`);
        } else if (!q.materialsExcl) {
          continue;
        }
      }
    }

    const where = conds.length ? conds.join(' AND ') : '1=1';
    plans.push({ src, table: `co_${src}`, where, params });
  }

  return { empty: false, plans, params: commonParams, wid };
}

function qualifyUserFilter(where, src) {
  const column = src === 'block' ? 'b.user' : 'c.user';
  return where.replace(/\buser\s+(IN|NOT IN)\s+\(/g, `${column} $1 (`);
}

function qualifyEventFilter(where, src) {
  const alias = src === 'block' ? 'b' : 'c';
  return where.replace(/(?<![.@])\b(user|wid|x|y|z|time|action|type)\b/g,
    (_match, column) => `${alias}.${column}`);
}

export function queryEvents(store, q) {
  const { empty, plans, params } = buildTablePlans(store, q);
  if (empty || !plans || plans.length === 0) {
    return { rows: [], elapsed: 0, truncated: false, count: 0 };
  }

  const limit = Math.min(+q.limit || store.cfg.defaultLimit || 50000, 200000);
  const db = store.getDb();
  const t0 = performance.now();

  let sql = '';
  if (plans.length === 1) {
    const p = plans[0];
    if (p.src === 'block') {
      sql = `
        SELECT 'block' AS src, b.rowid AS rowid_src, b.time,
               CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid,
               CAST(w.world AS TEXT) AS world, b.x, b.y, b.z,
               CASE WHEN b.action = 3 THEN CAST(e.entity AS TEXT) ELSE CAST(m.material AS TEXT) END AS material,
               NULL AS amount, b.action, b.rolled_back
        FROM co_block b
        LEFT JOIN co_user u ON u.id = b.user
        LEFT JOIN co_world w ON w.id = b.wid
        LEFT JOIN co_material_map m ON m.id = b.type
        LEFT JOIN co_entity_map e ON e.id = b.type
        WHERE ${qualifyEventFilter(p.where, p.src)}
        ORDER BY b.time DESC LIMIT ${limit}
      `;
    } else {
      sql = `
        SELECT '${p.src}' AS src, c.rowid AS rowid_src, c.time,
               CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid,
               CAST(w.world AS TEXT) AS world, c.x, c.y, c.z,
               CAST(m.material AS TEXT) AS material,
               c.amount, c.action, c.rolled_back
        FROM ${p.table} c
        LEFT JOIN co_user u ON u.id = c.user
        LEFT JOIN co_world w ON w.id = c.wid
        LEFT JOIN co_material_map m ON m.id = c.type
        WHERE ${qualifyEventFilter(p.where, p.src)}
        ORDER BY c.time DESC LIMIT ${limit}
      `;
    }
  } else {
    const parts = plans.map(p => {
      if (p.src === 'block') {
        return `
          SELECT 'block' AS src, b.rowid AS rowid_src, b.time,
                 CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid,
                 CAST(w.world AS TEXT) AS world, b.x, b.y, b.z,
                 CASE WHEN b.action = 3 THEN CAST(e.entity AS TEXT) ELSE CAST(m.material AS TEXT) END AS material,
                 NULL AS amount, b.action, b.rolled_back
          FROM co_block b
          LEFT JOIN co_user u ON u.id = b.user
          LEFT JOIN co_world w ON w.id = b.wid
          LEFT JOIN co_material_map m ON m.id = b.type
          LEFT JOIN co_entity_map e ON e.id = b.type
          WHERE ${qualifyEventFilter(p.where, p.src)}
        `;
      } else {
        return `
          SELECT '${p.src}' AS src, c.rowid AS rowid_src, c.time,
                 CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid,
                 CAST(w.world AS TEXT) AS world, c.x, c.y, c.z,
                 CAST(m.material AS TEXT) AS material,
                 c.amount, c.action, c.rolled_back
          FROM ${p.table} c
          LEFT JOIN co_user u ON u.id = c.user
          LEFT JOIN co_world w ON w.id = c.wid
          LEFT JOIN co_material_map m ON m.id = c.type
          WHERE ${qualifyEventFilter(p.where, p.src)}
        `;
      }
    });

    sql = `
      SELECT * FROM (
        ${parts.join('\nUNION ALL\n')}
      )
      ORDER BY time DESC LIMIT ${limit}
    `;
  }

  const rows = db.prepare(sql).all(params);
  // Преобразуем строковые поля при необходимости
  for (const r of rows) {
    r.nick = toStr(r.nick);
    r.uuid = toStr(r.uuid);
    r.world = toStr(r.world);
    r.material = toStr(r.material);
  }

  return {
    rows,
    elapsed: Math.round(performance.now() - t0),
    truncated: rows.length >= limit,
  };
}

export function aggregateChunks(store, q) {
  const { empty, plans, params, wid } = buildTablePlans(store, q);
  if (empty || !plans || plans.length === 0) {
    return { chunks: [], elapsed: 0 };
  }

  const db = store.getDb();
  const t0 = performance.now();

  const parts = plans.map(p => `
    SELECT '${p.src}' AS src, user, action, (x >> 4) AS cx, (z >> 4) AS cz, time
    FROM ${p.table}
    WHERE ${p.where}
  `);

  const sql = `
    WITH all_events AS (
      ${parts.join('\nUNION ALL\n')}
    ),
    chunk_totals AS (
      SELECT cx, cz, COUNT(*) AS cnt, COUNT(DISTINCT user) AS users,
             MIN(time) AS tmin, MAX(time) AS tmax
      FROM all_events
      GROUP BY cx, cz
    ),
    dominant_cte AS (
      SELECT cx, cz, user, src, action, cnt,
             ROW_NUMBER() OVER (PARTITION BY cx, cz ORDER BY cnt DESC) AS rn
      FROM (
        SELECT cx, cz, user, src, action, COUNT(*) AS cnt
        FROM all_events
        GROUP BY cx, cz, user, src, action
      )
    )
    SELECT t.cx, t.cz, t.cnt, t.users, t.tmin, t.tmax,
           d.src, d.action, CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid
    FROM chunk_totals t
    LEFT JOIN dominant_cte d ON d.cx = t.cx AND d.cz = t.cz AND d.rn = 1
    LEFT JOIN co_user u ON u.id = d.user
  `;

  const rows = db.prepare(sql).all(params);
  const chunks = rows.map(r => ({
    cx: r.cx,
    cz: r.cz,
    cnt: r.cnt,
    users: r.users,
    tmin: r.tmin,
    tmax: r.tmax,
    dominant: r.src ? {
      src: r.src,
      action: r.action,
      nick: toStr(r.nick),
      uuid: toStr(r.uuid),
    } : null,
  }));

  const elapsed = Math.round(performance.now() - t0);
  return { chunks, elapsed, elapsedMs: elapsed };
}

export function bboxOf(rows) {
  if (!rows.length) return null;
  let x1 = Infinity, x2 = -Infinity, z1 = Infinity, z2 = -Infinity;
  for (const r of rows) {
    if (r.x < x1) x1 = r.x; if (r.x > x2) x2 = r.x;
    if (r.z < z1) z1 = r.z; if (r.z > z2) z2 = r.z;
  }
  return { x1, x2, z1, z2 };
}

export function bboxOfChunks(chunks) {
  if (!chunks.length) return null;
  let x1 = Infinity, x2 = -Infinity, z1 = Infinity, z2 = -Infinity;
  for (const c of chunks) {
    const ax = c.cx * 16, az = c.cz * 16;
    if (ax < x1) x1 = ax; if (ax + 15 > x2) x2 = ax + 15;
    if (az < z1) z1 = az; if (az + 15 > z2) z2 = az + 15;
  }
  return { x1, x2, z1, z2 };
}

export function getEvent(store, src, rowid) {
  const db = store.getDb();
  let row = null;
  const rid = +rowid;

  if (src === 'block' || src === 'entity') {
    row = db.prepare(`
      SELECT 'block' AS src, b.rowid AS rowid_src, b.time, b.user AS user_id,
             CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid,
             CAST(w.world AS TEXT) AS world, b.wid, b.x, b.y, b.z,
             CASE WHEN b.action = 3 THEN CAST(e.entity AS TEXT) ELSE CAST(m.material AS TEXT) END AS material,
             NULL AS amount, b.action, b.rolled_back
      FROM co_block b
      LEFT JOIN co_user u ON u.id = b.user
      LEFT JOIN co_world w ON w.id = b.wid
      LEFT JOIN co_material_map m ON m.id = b.type
      LEFT JOIN co_entity_map e ON e.id = b.type
      WHERE b.rowid = ?
    `).get(rid);
  } else if (src === 'container') {
    row = db.prepare(`
      SELECT 'container' AS src, c.rowid AS rowid_src, c.time, c.user AS user_id,
             CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid,
             CAST(w.world AS TEXT) AS world, c.wid, c.x, c.y, c.z,
             CAST(m.material AS TEXT) AS material,
             c.amount, c.action, c.rolled_back
      FROM co_container c
      LEFT JOIN co_user u ON u.id = c.user
      LEFT JOIN co_world w ON w.id = c.wid
      LEFT JOIN co_material_map m ON m.id = c.type
      WHERE c.rowid = ?
    `).get(rid);
  } else if (src === 'item') {
    row = db.prepare(`
      SELECT 'item' AS src, i.rowid AS rowid_src, i.time, i.user AS user_id,
             CAST(u.user AS TEXT) AS nick, CAST(u.uuid AS TEXT) AS uuid,
             CAST(w.world AS TEXT) AS world, i.wid, i.x, i.y, i.z,
             CAST(m.material AS TEXT) AS material,
             i.amount, i.action, i.rolled_back
      FROM co_item i
      LEFT JOIN co_user u ON u.id = i.user
      LEFT JOIN co_world w ON w.id = i.wid
      LEFT JOIN co_material_map m ON m.id = i.type
      WHERE i.rowid = ?
    `).get(rid);
  }

  if (!row) return null;

  return {
    ...row,
    nick: toStr(row.nick),
    uuid: toStr(row.uuid),
    world: toStr(row.world),
    material: toStr(row.material),
  };
}

export function nearbyByUser(store, ev, radius = 16) {
  if (!ev || ev.user_id == null || ev.wid == null) return [];
  const db = store.getDb();

  const params = {
    wid: ev.wid,
    user: ev.user_id,
    x1: ev.x - radius,
    x2: ev.x + radius,
    z1: ev.z - radius,
    z2: ev.z + radius,
    tFrom: ev.time - 3600,
    tTo: ev.time + 3600,
    originTime: ev.time,
    originX: ev.x,
    originZ: ev.z,
  };

  const sql = `
    SELECT src, rowid_src, time, nick, material, action, x, y, z
    FROM (
      SELECT 'block' AS src, b.rowid AS rowid_src, b.time, CAST(u.user AS TEXT) AS nick,
             CASE WHEN b.action = 3 THEN CAST(e.entity AS TEXT) ELSE CAST(m.material AS TEXT) END AS material,
             b.action, b.x, b.y, b.z
      FROM co_block b
      LEFT JOIN co_user u ON u.id = b.user
      LEFT JOIN co_material_map m ON m.id = b.type
      LEFT JOIN co_entity_map e ON e.id = b.type
      WHERE b.wid = @wid AND b.user = @user
        AND b.x BETWEEN @x1 AND @x2
        AND b.z BETWEEN @z1 AND @z2
        AND b.time BETWEEN @tFrom AND @tTo

      UNION ALL

      SELECT 'container' AS src, c.rowid AS rowid_src, c.time, CAST(u.user AS TEXT) AS nick,
             CAST(m.material AS TEXT) AS material,
             c.action, c.x, c.y, c.z
      FROM co_container c
      LEFT JOIN co_user u ON u.id = c.user
      LEFT JOIN co_material_map m ON m.id = c.type
      WHERE c.wid = @wid AND c.user = @user
        AND c.x BETWEEN @x1 AND @x2
        AND c.z BETWEEN @z1 AND @z2
        AND c.time BETWEEN @tFrom AND @tTo

      UNION ALL

      SELECT 'item' AS src, i.rowid AS rowid_src, i.time, CAST(u.user AS TEXT) AS nick,
             CAST(m.material AS TEXT) AS material,
             i.action, i.x, i.y, i.z
      FROM co_item i
      LEFT JOIN co_user u ON u.id = i.user
      LEFT JOIN co_material_map m ON m.id = i.type
      WHERE i.wid = @wid AND i.user = @user
        AND i.x BETWEEN @x1 AND @x2
        AND i.z BETWEEN @z1 AND @z2
        AND i.time BETWEEN @tFrom AND @tTo
    )
    ORDER BY ABS(time - @originTime), ABS(x - @originX) + ABS(z - @originZ)
    LIMIT 50
  `;

  const rows = db.prepare(sql).all(params);
  for (const r of rows) {
    r.nick = toStr(r.nick);
    r.material = toStr(r.material);
  }
  return rows;
}
