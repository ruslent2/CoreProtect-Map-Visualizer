import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.js';
import { parseFilters, parseSnapshot, parseCursor, queryEvents, queryPlan, aggregateChunks, getEvent, nearbyEvents, bboxOf, bboxOfChunks, encodeCursor } from './queries.js';
import { normalizeConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '../..');

function log(level, message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console[level](`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}`);
}

/** Builds the backend without opening a listener, allowing isolated endpoint tests. */
export async function buildApp({ store, cfg, rootDir = defaultRootDir } = {}) {
  const normalizedCfg = normalizeConfig(cfg);
  if (!store) throw new Error('buildApp requires a store');
  cfg = normalizedCfg;
  store.cfg = cfg;
  const app = Fastify({ logger: false });

app.addHook('onRequest', (req, reply, done) => {
  req.cpmvStartedAt = performance.now();
  log('log', `HTTP ${req.method} ${req.url} — начало`);
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return reply.send();
  done();
});

app.addHook('onResponse', (req, reply, done) => {
  const elapsedMs = Math.round(performance.now() - (req.cpmvStartedAt ?? performance.now()));
  log('log', `HTTP ${req.method} ${req.url} — ответ ${reply.statusCode} за ${elapsedMs} мс`);
  done();
});

app.setErrorHandler((error, req, reply) => {
  log('error', `HTTP ${req.method} ${req.url} — необработанная ошибка запроса.`, {
    message: error.message,
    stack: error.stack,
  });
  reply.code(error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500).send({
    error: 'internal server error',
    detail: error.message,
  });
});

app.get('/api/meta', async () => {
  try {
    const meta = store.getMeta();
    log('log', 'Метаданные базы подготовлены.', {
      worlds: meta.worlds.length,
      users: meta.users.length,
      materials: meta.materials.length,
    });
    return meta;
  } catch (error) {
    log('error', 'Не удалось получить метаданные базы.', { message: error.message, stack: error.stack });
    return { error: 'db not ready', detail: String(error) };
  }
});

app.get('/api/config', async () => ({
  bluemap: cfg.bluemap ?? { enabled: false },
  defaultLimit: cfg.defaultLimit,
  materialNamePrefixesToStrip: cfg.materialNamePrefixesToStrip,
  coreProtectTiles: cfg.coreProtectTiles,
}));

// Прокси Bluemap нужен, потому что внешний сервер не отдаёт CORS-заголовок.
// PNG проходит через backend без записи на диск и без изменения исходных данных.
app.get('/api/bluemap/:world/:zoom/:tx/:tz.png', async (req, reply) => {
  const bluemap = cfg.bluemap ?? {};
  if (!bluemap.enabled || !bluemap.baseUrl) return reply.code(404).send({ error: 'bluemap disabled' });
  const world = encodeURIComponent(req.params.world);
  const zoom = encodeURIComponent(req.params.zoom);
  const tx = encodeURIComponent(req.params.tx);
  const tz = encodeURIComponent(req.params.tz);
  const url = `${bluemap.baseUrl.replace(/\/$/, '')}/maps/${world}/tiles/${zoom}/x${tx}/z${tz}.png`;
  const response = await fetch(url);
  if (!response.ok) return reply.code(response.status).send({ error: `Bluemap tile ${response.status}` });
  reply.header('Content-Type', response.headers.get('content-type') || 'image/png');
  reply.header('Cache-Control', 'public, max-age=300');
  return reply.send(Buffer.from(await response.arrayBuffer()));
});

app.get('/api/sync/status', async () => store.status);

app.post('/api/sync/start', async () => {
  try {
    log('log', 'Запущено обновление метаданных базы.');
    store.refreshMeta();
    log('log', 'Обновление метаданных базы завершено.');
  } catch (error) {
    store.status.error = String(error);
    log('error', 'Ошибка обновления метаданных базы.', { message: error.message, stack: error.stack });
  }
  return store.status;
});

app.post('/api/meta/refresh', async (_req, reply) => {
  try {
    store.refreshMeta();
    return store.getMeta();
  } catch (error) {
    log('error', 'Ошибка обновления метаданных.', { message: error.message, stack: error.stack });
    return reply.code(500).send({ error: 'metadata refresh failed', detail: error.message });
  }
});

app.get('/api/query', async (req) => {
  try {
    const q = parseFilters(req.query);
    const snapshot = parseSnapshot(req.query.snapshot);
    const cursor = parseCursor(req.query.cursor);
    const res = queryEvents(store, q, snapshot, cursor);
    log('log', 'Запрос событий завершён.', { count: res.rows.length, elapsedMs: res.elapsed, truncated: res.truncated });
    return { count: res.rows.length, hasMore: res.hasMore, nextCursor: res.hasMore && res.rows.length ? encodeCursor(res.rows.at(-1)) : null, snapshot: res.snapshot, truncated: res.truncated, elapsedMs: res.elapsed, events: res.rows, bbox: bboxOf(res.rows) };
  } catch (error) {
    log('error', 'Ошибка запроса событий.', { message: error.message, stack: error.stack, query: req.query });
    throw error;
  }
});

app.get('/api/query-plan', async (req) => {
  try {
    const q = parseFilters(req.query);
    return queryPlan(store, q, parseSnapshot(req.query.snapshot));
  } catch (error) {
    log('error', 'Ошибка плана запроса.', { message: error.message, query: req.query });
    throw error;
  }
});

app.get('/api/aggregate', async (req) => {
  try {
    const q = parseFilters(req.query);
    const snapshot = parseSnapshot(req.query.snapshot);
    const res = aggregateChunks(store, q, snapshot, q.tileSize ?? cfg.coreProtectTiles.tileSize);
    log('log', 'Агрегация событий завершена.', { chunks: res.chunks.length, elapsedMs: res.elapsedMs });
    return { ...res, bbox: bboxOfChunks(res.chunks) };
  } catch (error) {
    log('error', 'Ошибка агрегации событий.', { message: error.message, stack: error.stack, query: req.query });
    throw error;
  }
});

app.get('/api/event/:src/:rowid', async (req, reply) => {
  log('log', 'Запрос подробностей события.', { src: req.params.src, rowid: req.params.rowid });
  const ev = getEvent(store, req.params.src, req.params.rowid);
  if (!ev) return reply.code(404).send({ error: 'not found' });
  const nearby = nearbyEvents(store, ev);
  return { event: ev, nearby };
});

// Статика фронтенда (после npm run build в web/)
const distDir = path.join(rootDir, 'web', 'dist');
if (fs.existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith('/api')) reply.sendFile('index.html');
    else reply.code(404).send({ error: 'not found' });
  });
}

  return app;
}

const isDirectEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectEntryPoint) {
  const cfgPath = process.argv[2] || path.join(defaultRootDir, 'config.json');
  process.on('uncaughtException', (error) => {
    log('error', 'Необработанная ошибка (uncaughtException). Backend будет остановлен.', error);
    process.exitCode = 1;
  });
  process.on('unhandledRejection', (reason) => log('error', 'Необработанное отклонение Promise (unhandledRejection).', reason));

  if (!fs.existsSync(cfgPath)) {
    log('error', `Конфиг не найден: ${cfgPath}. Скопируйте config.example.json → config.json.`);
    process.exitCode = 1;
  } else {
    try {
      const cfg = normalizeConfig(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));
      const store = new Store(cfg, defaultRootDir);
      try { store.open(); } catch (error) { log('error', 'Ошибка открытия базы данных.', { message: error.message, stack: error.stack }); }
      buildApp({ store, cfg }).then(app => app.listen({ port: cfg.port, host: cfg.host })).then(() => {
        log('log', `CPMV server запущен: http://${cfg.host}:${cfg.port}`);
      }).catch(error => {
        log('error', 'Backend не смог запуститься.', { message: error.message, stack: error.stack });
        process.exitCode = 1;
      });
    } catch (error) {
      log('error', 'Не удалось прочитать или разобрать конфигурацию.', { message: error.message, stack: error.stack });
      process.exitCode = 1;
    }
  }
}
