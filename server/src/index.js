import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.js';
import { parseFilters, queryEvents, aggregateChunks, getEvent, nearbyByUser, bboxOf, bboxOfChunks } from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

const cfgPath = process.argv[2] || path.join(rootDir, 'config.json');

function log(level, message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  console[level](`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}`);
}

process.on('uncaughtException', (error) => {
  log('error', 'Необработанная ошибка (uncaughtException). Backend будет остановлен.', {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log('error', 'Необработанное отклонение Promise (unhandledRejection).', {
    message: error.message,
    stack: error.stack,
  });
});

log('log', 'Запуск backend CoreProtect Map Visualizer.', {
  pid: process.pid,
  node: process.version,
  cwd: process.cwd(),
  config: cfgPath,
});

if (!fs.existsSync(cfgPath)) {
  log('error', `Конфиг не найден: ${cfgPath}. Скопируйте config.example.json → config.json.`);
  process.exit(1);
}
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  log('log', 'Конфигурация загружена.', { host: cfg.host, port: cfg.port, databasePath: cfg.databasePath });
} catch (error) {
  log('error', 'Не удалось прочитать или разобрать конфигурацию.', { message: error.message, stack: error.stack });
  process.exit(1);
}

const store = new Store(cfg, rootDir);
try {
  store.open();
  log('log', 'CoreProtect DB подключена.', { databasePath: store.dbPath });
} catch (error) {
  log('error', 'Ошибка открытия базы данных. Сервер продолжит запуск, запросы будут сообщать об ошибке.', {
    message: error.message,
    stack: error.stack,
  });
}

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
  defaultLimit: cfg.defaultLimit ?? 50000,
}));

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

app.get('/api/query', async (req) => {
  try {
    const q = parseFilters(req.query);
    const res = queryEvents(store, q);
    log('log', 'Запрос событий завершён.', { count: res.rows.length, elapsedMs: res.elapsed, truncated: res.truncated });
    return { count: res.rows.length, truncated: res.truncated, elapsedMs: res.elapsed, events: res.rows, bbox: bboxOf(res.rows) };
  } catch (error) {
    log('error', 'Ошибка запроса событий.', { message: error.message, stack: error.stack, query: req.query });
    throw error;
  }
});

app.get('/api/aggregate', async (req) => {
  try {
    const q = parseFilters(req.query);
    const res = aggregateChunks(store, q);
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
  const nearby = nearbyByUser(store, ev);
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

app.listen({ port: cfg.port, host: cfg.host }).then(() => {
  log('log', `CPMV server запущен: http://${cfg.host}:${cfg.port}`);
  log('log', `CoreProtect DB: ${store.dbPath}`);
}).catch((error) => {
  log('error', 'Backend не смог запуститься.', { message: error.message, stack: error.stack });
  process.exitCode = 1;
});
