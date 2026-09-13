# PROJECT_CONTEXT.md — CoreProtect Map Visualizer

Веб-карта для админов Minecraft-сервера: показывает события CoreProtect (кто, что, где сломал/поставил/взял/убил) в виде цветных точек/чанков поверх top-down проекции мира, с фильтрами по игроку/действию/материалу/времени/области и опциональной растровой подложкой Bluemap.

Локальный self-hosted инструмент, без деплоя в облако, без БД помимо самой БД CoreProtect.

---

## 1. Стек технологий

**Backend (`server/`)**
- Node.js, ESM (`"type": "module"`)
- **Fastify 5** — HTTP-сервер, роуты `/api/*`, раздача статики фронта
- `@fastify/static` — отдаёт собранный `web/dist`
- **better-sqlite3** — синхронный **read-only** доступ к живой SQLite-базе плагина CoreProtect
- Никакого ORM — весь SQL пишется руками в `queries.js`
- `node:test` (встроенный раннер) — юнит-тесты

**Frontend (`web/`)**
- TypeScript + **Vite 5**
- **Pixi.js 8** (WebGL) — CoreProtect-данные растеризуются в небольшие Canvas transport tiles и загружаются в `Sprite`; один Canvas на общий bbox результатов не используется
- **Vitest** — тесты чистых frontend helpers, очереди детализации и generation-safe tiled renderer
- Никакого UI-фреймворка — панель фильтров, легенда, инспектор события собраны руками через `document.createElement`/`innerHTML`
- Чистый CSS, без препроцессоров/Tailwind

**Прочее**
- **Bluemap** — опциональная интеграция с уже запущенной отдельно картой Bluemap: только чтение PNG-тайлов по HTTP как подложки, никакой другой связи
- Конфигурация — единый `config.json` в корне репозитория (не `.env`)

---

## 2. Архитектура

```
/
├─ config.example.json / config.json   — путь к БД CoreProtect, порт/хост, настройки Bluemap, лимиты
├─ package.json                         — корневые npm-скрипты поверх server/ и web/
├─ server/
│  ├─ src/db.js       — класс Store: открытие БД (readonly), чтение справочников
│  │                     (миры/игроки/материалы/сущности) в Map'ы в памяти,
│  │                     константа ACTIONS (человеко-читаемые названия действий)
│  ├─ src/config.js   — нормализация defaultLimit и coreProtectTiles
│  ├─ src/queries.js  — общие фильтры SQL, snapshots, capped query-plan,
│  │                     keyset-страницы событий, all-source chunk overview,
│  │                     запрос события и соседей
│  ├─ src/index.js    — экспортируемый buildApp({ store, cfg }), Fastify routes,
│  │                     production listener и раздача web/dist
│  └─ test/           — in-memory SQLite regression/endpoint tests
├─ web/
│  ├─ src/state.ts    — Filters, TimeSelection, local datetime helpers, policy служебных фильтров
│  ├─ src/api.ts      — типизированные abortable fetch-обёртки над /api/*
│  ├─ src/colors.ts    — вся цветовая логика (режимы user/action/material/time, подмес, яркость)
│  ├─ src/tile-utils.ts — transport tile keys/bounds, queue sort и dedupe helpers
│  ├─ src/tiled-renderer.ts — tile raster planning, LOD helpers и generation/resource ownership
│  ├─ src/scan-pipeline.ts — DOM-free generation gate и фиксированная detail queue
│  ├─ src/map.ts       — generation-safe tiled Pixi renderer, camera и hit-testing по tile
│  ├─ src/tiles.ts     — класс BluemapLayer: подгрузка/выгрузка PNG-тайлов Bluemap под текущий вьюпорт
│  ├─ src/ui.ts        — построение панели фильтров и легенды (vanilla DOM)
│  ├─ src/main.ts      — draft/applied state, ручной scan pipeline, инспектор и HUD
│  ├─ test/            — Vitest tests state/tile/renderer/pipeline helpers
│  └─ dist/            — уже собранный билд (закоммичен в этом снэпшоте, см. раздел 4)
└─ tsconfig.json, vite.config.ts, package.json (в server/ и web/)
```

---

## 3. Поток данных

1. **Источник** — сама живая SQLite-база плагина CoreProtect (`database.db`), путь к ней задаётся в `config.json → databasePath`. Никакого ETL/копирования/промежуточного хранилища нет — сервер читает исходную базу напрямую.
2. При старте (`db.js → Store.open()`) открывается **read-only** соединение (`better-sqlite3`, `readonly: true, fileMustExist: true`), сразу читаются справочники `co_world`, `co_user`, `co_material_map`, `co_entity_map` → складываются в `Map`'ы в памяти (`Store.maps`) для быстрого перевода имя↔id при построении фильтров.
3. При загрузке фронт делает только `GET /api/config` и `GET /api/meta`, затем загружает BlueMap. CoreProtect endpoints (`/api/query-plan`, `/api/aggregate`, `/api/query`) **не вызываются автоматически**.
4. Значения панели — это **draft state**. Изменение фильтра, времени, bbox, панорамирование, zoom и resize меняют только UI/HUD/BlueMap; старые applied CoreProtect tiles остаются видимы. Если draft world отличается от applied world, HUD сообщает, к какому миру относятся показанные данные.
5. Ручной Apply (`Обновить данные` либо `Ctrl+Enter` / `Cmd+Enter`) сначала вызывает `POST /api/meta/refresh`, фиксирует время и камеру, затем получает `/api/query-plan`. Для каждого запуска создаётся generation и `AbortController`; устаревшие ответы не имеют права менять карту.
   - **Малая выборка (`all`)**: все keyset-страницы загружаются без viewport bbox, дедуплицируются по `${src}:${rowid_src}`, группируются по transport tiles и атомарно commit-ятся в renderer.
   - **Большая выборка (`overview-and-detail`)**: сначала `/api/aggregate` получает полный overview занятых Minecraft chunks. Overview commit-ится как aggregate tiles. Затем загружаются detail pages только для occupied transport tiles, в фиксированном порядке от transport tile камеры на момент Apply.
6. Backend читает `co_block`, `co_container` и `co_item` под snapshot верхних `rowid`. Detail pagination использует keyset order `time DESC, source_rank ASC, rowid_src DESC`; у transport tiles полуоткрытые границы, поэтому соседние области не дублируют события.
7. Ховер/клик по загруженным detail events использует per-tile hit-index и не делает запросов. Клик по aggregate chunk может приоритизировать его transport tile в уже зафиксированной очереди. Открытие инспектора конкретного события → `GET /api/event/:src/:rowid`: точечный `SELECT` по `rowid` и подзапрос "рядом" для того же игрока (±1 час, ±16 блоков, до 50 строк).
8. Bluemap-подложка (если включена в конфиге) — полностью независимый поток: PNG-тайлы запрашиваются через same-origin backend-прокси `/api/bluemap/:world/:zoom/:tx/:tz.png`, потому что внешний Bluemap не отдаёт CORS-заголовок. Прокси получает PNG с внешнего сервера и отдаёт его браузеру с коротким HTTP-кэшем. Нижняя половина исходного PNG отбрасывается: BlueMap отдаёт вертикальное изображение примерно 501×1002, где верхняя половина — карта, нижняя — карта высот. Никакой цветокоррекции не выполняется.
9. Состояние фильтров и applied request живёт только в памяти вкладки; нет ни localStorage, ни отражения в URL query-параметрах браузера.

---

## 4. Неочевидные нюансы, костыли и договорённости

- **БД CoreProtect только для чтения — это осознанная гарантия безопасности.** Соединение открывается с `readonly: true`; любая новая фича не должна ничего писать в исходный файл — это живые данные анти-грифф плагина.
- **`/api/sync/start` и `/api/sync/status` не синхронизируют события.** Они сохранены для совместимости и обновляют/показывают только metadata state. Ручной pipeline использует честный `POST /api/meta/refresh`; копирования CoreProtect событий в проекте нет.
- **Конфигурация transport tiles.** `defaultLimit` нормализуется в диапазон `1..200000`; `coreProtectTiles.tileSize` — `16..2048` и кратен 16; параллелизм — `1..4`; `detailPageSize` — `100..20000`. Нормализованные значения отдаёт `/api/config`; frontend использует их для лимита и renderer/queue, а не собственный hardcoded порог.
- **Время — это intent, не только null-поля.** `TimeSelection.mode` различает `default` (последние 6 часов в момент Apply), `range` и явное `all`. `datetime-local` преобразуется в local timezone без `toISOString()`. Начало без конца фиксирует конец в момент Apply; обратный диапазон не запускает SQL.
- **Служебный фильтр.** `defaultFilters().users` содержит `!#*`; он сериализуется в SQL и исключает CoreProtect actors, начинающихся с `#`. Он не считается meaningful UI filter благодаря расширяемому `NON_MEANINGFUL_FILTER_VALUES`.
- **`config.json` содержит неиспользуемые поля** `cachePath` и `syncIntervalMs` — судя по всему, наследие от более раннего/планировавшегося слоя кэширования, которого в текущем коде нет. Не стоит считать, что кэш где-то есть, ориентируясь на конфиг.
- **Активен всегда один мир.** Если `world` не совпал ни с одним известным именем — тихий фолбэк на первый мир из `co_world` по `id`, никакого настоящего режима "все миры сразу" нет.
- **Фильтр по Y — точное совпадение**, не диапазон (`y = @y`). Карта — плоская top-down проекция, поэтому пустой Y (все уровни разом) — обычный сценарий использования.
- **Фильтры игроков и материалов задаются многострочными glob-шаблонами.** Один шаблон вводится на строку; `*` соответствует нулю или более символам, `?` — одному символу, `!` в начале исключает совпадения, а `(?i)` в начале включает чувствительность к регистру. Последнее совпавшее правило переопределяет предыдущие. Если есть положительные правила, выбираются только совпавшие имена; если есть только отрицательные — исходно включены все имена. Для обоих полей есть выпадающее автодополнение по спискам из `/api/meta`; ввод не отправляет запрос после каждого символа и допускает `Enter` для новой строки.
- **Порядок фильтров в панели:** игроки, материалы, действия. Игроки и материалы используют текстовые поля с автодополнением, действия остаются чекбокс-списком с отдельным переключателем исключения.
- **Коды действий CoreProtect захардкожены под конкретную схему**: `co_block` (0=break,1=place,2=interact,3=kill/other), `co_container` (0=take,1=put), `co_item` (0=drop,1=pickup,2=throw). Если у админа другая версия CoreProtect с иной схемой — маппинг может быть неверным, стоит перепроверять при интеграции.
- **`entity_kill` и `other` — фактически один и тот же фильтр.** Оба маппятся на `co_block, action=3` (`ACTION_MAP` в `queries.js`). Разделить их фильтром по действию нельзя — отображаемое имя (материал vs сущность) решается отдельно, жёстким правилом `CASE WHEN action = 3 THEN <имя сущности> ELSE <имя материала>` в SQL. Любое иное "прочее" действие с кодом 3, которое не является убийством сущности, всё равно попытается резолвиться как сущность.
- **Include/Exclude — асимметричная реализация**, а не просто смена `IN`/`NOT IN` в WHERE. При *включении* действий сужается сам набор опрашиваемых таблиц (`activeSources`) — таблица без выбранных действий вообще не участвует в `UNION ALL`. При *исключении* — участвуют все три таблицы всегда, просто с `NOT IN`. То же самое для фильтра материалов.
- **Рендер — tiled Canvas2D → Pixi Texture.** Canvas создаётся только для transport tile или его internal subtile; `maxTextureSize` ограничивает его стороны. Поэтому удалённые события не выделяют огромную текстуру между собой. Aggregate и detail layers разделены; detail скрывает aggregate texture той же области. Ресурсы Sprite/Texture/textureSource уничтожаются при замене или очистке tile.
- **Renderer имеет two-phase generation lifecycle.** Новое поколение staging tiles не удаляет старую committed карту до `commitDataGeneration`. Ошибка plan/overview может сохранить прошлый результат; details устанавливаются инкрементально поверх committed overview только для текущего generation.
- **Камера не запускает SQL.** `scale` — пикселей на блок, пределы `1/16..64`; callback камеры срабатывает только при фактическом изменении camera/renderer dimensions. Pan, zoom и resize обновляют HUD/BlueMap. При zoom используется фактический clamped ratio, сохраняя блок под курсором.
- **Полный aggregate overview всё ещё синхронный.** `better-sqlite3` блокирует event loop на время SQL. Snapshot защищает от новых строк, но не от удаления старых внешним процессом; frontend дедуплицирует event IDs и может показывать расхождение сводки.
- **Detail pagination не использует OFFSET.** Каждая страница выбирает `pageSize + 1`, строит `hasMore`, и продолжает keyset cursor до конца плотного transport tile.
- **Память при очень больших scan.** Первая версия не выгружает уже загруженные detail tiles автоматически. Пользователь может нажать `Остановить`; overview и готовые details сохраняются. Для миллионов событий возможен browser memory limit — это требует отдельной политики eviction/лимита, которой сейчас нет.
- **Нет авторизации вообще**, плюс `Access-Control-Allow-Origin: *` на каждом ответе. Инструмент рассчитан на запуск только в доверенной сети/локально — иначе координаты и активность игроков доступны любому, кто достучится до порта.
- **`web/dist` (собранный бандл) присутствует в снэпшоте репозитория.** Backend раздаёт статику фронта только если `web/dist` существует (`fs.existsSync(distDir)`) — то есть после `npm run build` в `web/`. Без сборки нужно запускать Vite dev-сервер отдельно (см. раздел 5).
- В этом дампе `config.json` содержит реальный абсолютный Windows-путь (`F:/Mine/CoreProtect-Map-Visualizer/...`) — стоит убедиться, что файл в `.gitignore`, и в репозиторий коммитится только `config.example.json`.
- `toStr()` в `db.js` умеет разворачивать `Buffer`/`Uint8Array` в строку — защита от того, что некоторые сборки/драйверы SQLite отдают TEXT-колонки как BLOB.
- `co_entity_map` оборачивается в `try/catch` при чтении — таблица может отсутствовать в некоторых версиях CoreProtect, тогда список сущностей просто остаётся пустым, без падения.

### Bluemap-интеграция

- Фактический URL внешнего тайла: `/maps/{world}/tiles/{zoom}/x{x}/z{z}.png`.
- Фронтенд использует `/api/bluemap/{world}/{zoom}/{x}/{z}.png`, а backend проксирует PNG, чтобы обойти CORS.
- Формат LOD: `zoom=1` — 1 пиксель = 1 блок и `501×501` блоков на грань; `zoom=2` — 5 блоков на пиксель и `2505×2505`; `zoom=3` — 25 блоков на пиксель и `12525×12525`.
- Исходный PNG имеет примерно `501×1002` пикселей. `BluemapLayer.cropMapHalf()` оставляет только верхнюю половину; нижняя карта высот отбрасывается. Цвета не изменяются.
- В `config.json` и `config.example.json`: `tileSize: 500`, `tileAspectRatio: 1`, `blocksPerTileAtZoom0: 501`, `lodFactor: 5`, `maxZoom: 3`.
- `BluemapLayer` вызывает `setWorld(filters.world)`, кэширует загруженные и ожидающие тайлы, не повторяет запросы для неизменившегося viewport и отбрасывает устаревшие загрузки после смены zoom/мира.

### API ручного scan

| Endpoint | Назначение |
| --- | --- |
| `GET /api/config` | Нормализованные `defaultLimit`, `coreProtectTiles` и BlueMap config. |
| `POST /api/meta/refresh` | Обновляет только metadata перед ручным scan. |
| `GET /api/query-plan` | Capped plan: стратегия `all`/`overview-and-detail`, threshold, snapshot и bounds для точной малой выборки. |
| `GET /api/aggregate` | Полный chunk overview под snapshot: chunks, occupied transport tiles, total, temporal summary и bbox. |
| `GET /api/query` | Cursor page событий под snapshot; поддерживает `pageSize`, cursor и полуоткрытые tile bounds `xMin/xMaxExclusive/zMin/zMaxExclusive`. |

Snapshot в текущем HTTP-контракте сериализуется query-параметром JSON как `{ "block": n, "container": n, "item": n }`. Внутренние названия полей отличаются от раннего черновика `*MaxRowid`, но имеют ту же семантику.

### Последние изменения

- Добавлен ручной CoreProtect scan: стартовая карта пуста, а кнопка `Обновить данные` и `Ctrl/Cmd+Enter` создают единственный pipeline. Обычный Enter в glob textarea не перехватывается.
- Добавлены точные local datetime inputs, пресеты `6ч`/`24ч`/`7д`/`30д`/`Всё время`, индикатор dirty state, статусы planning/overview/loading/stopped/error, `Показать все результаты` и `Остановить`.
- Внедрены draft/applied request, AbortController и generation protection. Смена draft world немедленно меняет BlueMap, но не CoreProtect data до Apply.
- Добавлены server-side нормализация конфигурации, Fastify factory `buildApp`, metadata refresh, strict filter validation, snapshots, capped query-plan, cursor pagination и full aggregate overview.
- Один Canvas по bbox заменён transport tiled renderer-ом с per-tile hit-index, resource cleanup, aggregate/detail layers и bounded texture splitting.
- Добавлены Vitest tests для time/filter/tile/renderer/pipeline helpers и server endpoint tests. Последняя подтверждённая проверка: server `14/14`, web `23/23`, `npm.cmd run build:web` успешно.
- Не подтверждены ручные browser сценарии, SQL `EXPLAIN QUERY PLAN` и performance measurements на копии реальной DB; не следует считать их выполненными.

---

## 5. Как запустить локально

1. Скопировать `config.example.json → config.json`, указать реальный `databasePath` (путь к `database.db` плагина CoreProtect), при необходимости `port`/`host` и настройки `bluemap` (если Bluemap-сервер уже поднят).
2. Установить зависимости обоих подпроектов:
   ```
   npm run install:all
   ```
   (эквивалент `cd server && npm install && cd ../web && npm install`)
3. **Вариант А — разработка с хот-релоадом (два процесса):**
   ```
   npm run dev:server   # Fastify на 127.0.0.1:3010, автоперезапуск на изменения (node --watch)
   npm run dev:web      # Vite dev-сервер на :5173, проксирует /api → :3010
   ```
   Открыть `http://127.0.0.1:5173`.
4. **Вариант Б — единый порт (ближе к «проду»):**
   ```
   npm run build:web    # tsc + vite build → web/dist
   npm run server       # (или dev:server) — Fastify отдаёт и API, и собранный фронт
   ```
   Открыть `http://<host>:<port>` из конфига (по умолчанию `http://127.0.0.1:3010`).
5. Тесты бэкенда (не требуют реальной БД CoreProtect, поднимают in-memory SQLite):
   ```
   cd server && npm.cmd test
   ```
6. Тесты frontend helpers:
   ```
   npm.cmd --prefix web test
   ```
