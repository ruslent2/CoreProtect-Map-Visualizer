import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stripMaterialNamePrefix } from './config.js';

function log(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] [DB] ${message}${suffix}`);
}

export function resolveDbPath(p, baseDir = process.cwd()) {
  if (!p) return p;
  if (p.startsWith('~/') || p.startsWith('~\\') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  if (path.isAbsolute(p)) {
    return p;
  }
  return path.resolve(baseDir, p);
}

export function toStr(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return Buffer.from(v).toString('utf8');
  }
  return String(v);
}

export const ACTIONS = [
  { id: 'break', label: 'Разрушение блока' },
  { id: 'place', label: 'Установка блока' },
  { id: 'interact', label: 'Взаимодействие' },
  { id: 'other', label: 'Прочее (kill/entity)' },
  { id: 'container_take', label: 'Изъятие из контейнера' },
  { id: 'container_put', label: 'Помещение в контейнер' },
  { id: 'item_drop', label: 'Выброс предмета' },
  { id: 'item_pickup', label: 'Подбор предмета' },
  { id: 'item_throw', label: 'Метание предмета' },
  { id: 'entity_kill', label: 'Убийство/разрушение сущности' },
];

export class Store {
  constructor(cfg, rootDir = process.cwd()) {
    this.cfg = cfg;
    this.dbPath = resolveDbPath(cfg.databasePath, rootDir);
    this.status = {
      running: false,
      mode: 'direct',
      ready: false,
      databasePath: this.dbPath,
      sources: {
        block: { rows: 0 },
        container: { rows: 0 },
        item: { rows: 0 },
      },
    };
    this.db = null;
    this.meta = null;
    this.maps = null;
  }

  open() {
    if (this.db) {
      log('Повторное открытие пропущено: база уже подключена.');
      return this.db;
    }
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`Файл базы данных не найден: ${this.dbPath}`);
    }

    log('Открытие SQLite базы данных.', { path: this.dbPath, sizeBytes: fs.statSync(this.dbPath).size });
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('journal_mode = WAL');
    } catch {
      // Игнорируем если уже в WAL или read-only
    }
    db.pragma('busy_timeout = 5000');
    this.db = db;
    log('SQLite подключена. Чтение метаданных.');
    this.refreshMeta();
    this.status.ready = true;
    log('SQLite база готова.', { worlds: this.meta.worlds.length, users: this.meta.users.length, materials: this.meta.materials.length });
    return this.db;
  }

  getDb() {
    if (!this.db) return this.open();
    return this.db;
  }

  refreshMeta() {
    const db = this.db;
    if (!db) {
      log('Обновление метаданных пропущено: база не подключена.');
      return;
    }

    const startedAt = performance.now();
    log('Чтение метаданных: миры, пользователи, материалы и сущности.');

    // Миры
    const worldsRaw = db.prepare('SELECT id, world FROM co_world ORDER BY id').all();
    const worlds = worldsRaw.map(r => ({ id: r.id, world: toStr(r.world) }));
    const worldNameToId = new Map();
    const worldIdToName = new Map();
    for (const w of worlds) {
      worldNameToId.set(w.world, w.id);
      worldIdToName.set(w.id, w.world);
    }

    // Пользователи
    const usersRaw = db.prepare('SELECT id, user, uuid FROM co_user ORDER BY user COLLATE NOCASE').all();
    const users = usersRaw.map(r => ({
      id: r.id,
      nick: toStr(r.user),
      uuid: toStr(r.uuid),
    }));
    const userNameToId = new Map();
    const userIdToUser = new Map();
    for (const u of users) {
      if (u.nick) userNameToId.set(u.nick.toLowerCase(), u.id);
      userIdToUser.set(u.id, u);
    }

    // Материалы блоков и предметов
    const matRaw = db.prepare('SELECT id, material FROM co_material_map').all();
    const materialNameToId = new Map();
    const materialIdToName = new Map();
    const materialsSet = new Set();

    for (const m of matRaw) {
      const name = toStr(m.material);
      if (name) {
        const displayName = stripMaterialNamePrefix(name, this.cfg.materialNamePrefixesToStrip);
        materialNameToId.set(name.toLowerCase(), m.id);
        materialNameToId.set(displayName.toLowerCase(), m.id);
        materialIdToName.set(m.id, displayName);
        materialsSet.add(displayName);
      }
    }

    // Сущности
    let entitiesRaw = [];
    try {
      entitiesRaw = db.prepare('SELECT id, entity FROM co_entity_map').all();
    } catch {
      // таблица может отсутствовать в некоторых сборках
    }
    const entityNameToId = new Map();
    const entityIdToName = new Map();
    for (const e of entitiesRaw) {
      const name = toStr(e.entity);
      if (name) {
        const displayName = stripMaterialNamePrefix(name, this.cfg.materialNamePrefixesToStrip);
        entityNameToId.set(name.toLowerCase(), e.id);
        entityNameToId.set(displayName.toLowerCase(), e.id);
        entityIdToName.set(e.id, displayName);
        materialsSet.add(displayName);
      }
    }

    const materials = Array.from(materialsSet).sort();

    this.meta = {
      worlds,
      users,
      materials,
      actions: ACTIONS,
    };

    this.maps = {
      worldNameToId,
      worldIdToName,
      userNameToId,
      userIdToUser,
      materialNameToId,
      materialIdToName,
      entityNameToId,
      entityIdToName,
    };
    log('Метаданные прочитаны.', {
      worlds: worlds.length,
      users: users.length,
      materials: materials.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  }

  getMeta() {
    if (!this.meta) {
      this.open();
    }
    return this.meta;
  }

  getMaps() {
    if (!this.maps) {
      this.open();
    }
    return this.maps;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
      log('SQLite база закрыта.');
    }
    this.status.ready = false;
  }
}
