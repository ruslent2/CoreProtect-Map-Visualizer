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
  { id: 'break', label: 'Руйнування блока', src: 'block', action: 0 },
  { id: 'place', label: 'Встановлення блока', src: 'block', action: 1 },
  { id: 'interact', label: 'Взаємодія', src: 'block', action: 2 },
  { id: 'entity_kill', label: 'Вбивство/руйнування сутності', src: 'block', action: 3 },
  { id: 'container_take', label: 'Вилучено з контейнера', src: 'container', action: 0 },
  { id: 'container_put', label: 'Поміщено до контейнера', src: 'container', action: 1 },
  { id: 'item_drop', label: 'Викинуто предмет', src: 'item', action: 2 },
  { id: 'item_pickup', label: 'Підібрано предмет', src: 'item', action: 3 },
  { id: 'ender_take', label: 'Вилучено з ендер-скрині', src: 'item', action: 4 },
  { id: 'ender_put', label: 'Поміщено до ендер-скрині', src: 'item', action: 5 },
  { id: 'item_throw', label: 'Кинуто предмет', src: 'item', action: 6 },
  { id: 'item_shoot', label: 'Вистрілено предметом', src: 'item', action: 7 },
  { id: 'item_break', label: 'Зламано інструмент або броню', src: 'item', action: 8 },
  { id: 'craft_put', label: 'Крафт: покладено', src: 'item', action: 9 },
  { id: 'craft_take', label: 'Крафт: забрано', src: 'item', action: 10 },
  { id: 'trade_give', label: 'Торгівля: віддано', src: 'item', action: 11 },
  { id: 'trade_receive', label: 'Торгівля: отримано', src: 'item', action: 12 },
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
      log('Повторне відкриття пропущено: базу вже підключено.');
      return this.db;
    }
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`Файл бази даних не знайдено: ${this.dbPath}`);
    }

    log('Відкриття бази даних SQLite.', { path: this.dbPath, sizeBytes: fs.statSync(this.dbPath).size });
    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('journal_mode = WAL');
    } catch {
      // Ігноруємо, якщо вже використовується WAL або лише читання
    }
    db.pragma('busy_timeout = 5000');
    this.db = db;
    log('SQLite підключено. Читання метаданих.');
    this.refreshMeta();
    this.status.ready = true;
    log('База SQLite готова.', { worlds: this.meta.worlds.length, users: this.meta.users.length, materials: this.meta.materials.length });
    return this.db;
  }

  getDb() {
    if (!this.db) return this.open();
    return this.db;
  }

  refreshMeta() {
    const db = this.db;
    if (!db) {
      log('Оновлення метаданих пропущено: базу не підключено.');
      return;
    }

    const startedAt = performance.now();
    log('Читання метаданих: світи, користувачі, матеріали й сутності.');

    // Світи
    const worldsRaw = db.prepare('SELECT id, world FROM co_world ORDER BY id').all();
    const worlds = worldsRaw.map(r => ({ id: r.id, world: toStr(r.world) }));
    const worldNameToId = new Map();
    const worldIdToName = new Map();
    for (const w of worlds) {
      worldNameToId.set(w.world, w.id);
      worldIdToName.set(w.id, w.world);
    }

    // Користувачі
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

    // Матеріали блоків і предметів
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

    // Сутності
    let entitiesRaw = [];
    try {
      entitiesRaw = db.prepare('SELECT id, entity FROM co_entity_map').all();
    } catch {
      // Таблиця може бути відсутньою в деяких збірках.
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
    log('Метадані прочитано.', {
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
      log('Базу SQLite закрито.');
    }
    this.status.ready = false;
  }
}
