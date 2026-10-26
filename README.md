# CoreProtect Map Visualizer

Self-hosted веб-карта для адміністраторів Minecraft-серверів: показує події плагіна CoreProtect (хто, що і де зламав / поставив / забрав з контейнера / вбив) у вигляді кольорових точок і чанків поверх top-down проекції світу, з опціональною растровою підкладкою Bluemap.

Інструмент читає живу SQLite-базу CoreProtect **лише read-only** — вихідні дані анти-гріфф плагіна ніколи не змінюються. Без хмарного деплою і без проміжних БД: сервер працює напряму з базою плагіна.

## Можливості

- **Фільтри подій**: гравці, матеріали, дії, час (пресети `6г` / `24г` / `7д` / `30д` / «Весь час») та Y
  - гравці й матеріали — багаторядкові glob-шаблони (`*`, `?`, `!` для виключення, `(?i)` для чутливості до регістру) з автодоповненням
- **Ручний запуск скану** (`Оновити дані` / `Ctrl+Enter`): мала вибірка завантажується повністю, велика — спочатку огляд зайнятих чанків, потім детальні дані окремим потоком
- **Інспектор події**: клік по точці показує деталі та сусідні дії того ж гравця (± 1 год, ± 16 блоків)
- **Колірні режими**: за гравцем / дією / матеріалом / часом
- **Bluemap-підкладка** (опційно): PNG-тайли зовнішнього Bluemap-сервера проходять через проксі бекенда (обхід CORS), нижня половина тайла (карта висот) відкидається
- **Discord OAuth авторизація** (опційно): вхід через Discord, ролі сервера визначають адміна/модератора, адмін-панель з чорним списком
- Локалізація інтерфейсу українською

## Як це працює

```
БД CoreProtect (SQLite) ──read-only──▶ Fastify-сервер /api/* ──▶ Web-інтерфейс (Pixi.js)
                                              ▲
Bluemap-сервер (PNG-тайли) ──проксі──────────┘
```

- Сервер (`server/`, Node.js + Fastify 5 + better-sqlite3) відкриває базу з `readonly: true` і виконує SQL напряму — без копіювання та ETL.
- Фронтенд (`web/`, TypeScript + Vite + Pixi.js 8) рендерить події плитковим Canvas→WebGL-рендером; камера/зум/панорамування не запускають SQL — запит виконується лише після `Оновити дані`.
- Фільтри редагуються як чернетка (draft) і застосовуються вручну; кожен запит захищений generation + `AbortController` — застарілі відповіді не змінюють карту.

## Вимоги

- **Node.js** 18+ (ESM; сервер — `better-sqlite3` з нативним біндінгом)
- **CoreProtect** плагін зі своєю SQLite-базою (`database.db`) та знайомою схемою (`co_block`, `co_container`, `co_item`, `co_world`, `co_user`, `co_material_map`; маппінг дій захардкожено під поточну схему — інші версії варто переперевіряти)
- Опційно:
  - **Bluemap** — вже запущений окремо (використовується як джерело PNG-тайлів)
  - **Discord Application** — для OAuth-авторизації (Client ID / Client Secret)

## Встановлення (продакшн)

1. **Клонуйте репозиторій** та встановіть залежності обох підпроектів:

   ```bash
   npm run install:all
   # еквівалент: cd server && npm install && cd ../web && npm install
   ```

2. **Скопіюйте конфіг** і вкажіть шлях до живої бази CoreProtect:

   ```bash
   cp config.example.json config.json   # Windows PowerShell: Copy-Item
   ```

   Відредагуйте `config.json` (`databasePath`, `port`, `host` тощо — див. таблицю нижче).

3. **(Опційно) Discord OAuth:**
   - На <https://discord.com/developers/applications> створіть Application і скопіюйте Client ID / Client Secret.
   - Додайте Redirect URI: `http://localhost:3010/api/auth/discord/callback` (має точно збігатися з `discordAuth.redirectUri` у конфігу).
   - Заповніть `discordAuth` у `config.json`: `guildId`, `adminRoleId`, `moderatorRoleIds` — ID вашого Discord-сервера та ролей.
   - Client ID/Secret зчитуються з змінних середовища (не з конфіга):

     ```bash
     # PowerShell
     $env:DISCORD_CLIENT_ID = '...'
     $env:DISCORD_CLIENT_SECRET = '...'
     # bash
     export DISCORD_CLIENT_ID='...'
     export DISCORD_CLIENT_SECRET='...'
     ```

   - Якщо авторизація не потрібна — встановіть `"discordAuth": { "enabled": false }` у конфігу.

4. **Зберіть фронтенд:**

   ```bash
   npm run build:web
   ```

5. **Запустіть сервер:**

   ```bash
   npm run server
   ```

   Відкрийте `http://localhost:3010` (або `host:port` з конфігу).
   > ⚠️ При увімкненій Discord-авторизації відкривайте сайт саме через `http://localhost:<port>`, а **не** `http://127.0.0.1:<port>` — cookie OAuth state не передається між цими адресами, і вхід завершиться помилкою `invalid oauth state`.

6. **Оновіть дані** на карті кнопкою `Оновити дані` (або `Ctrl+Enter`) — перший скан подій.

## Розробка (hot-reload)

```bash
npm run dev:server   # Fastify на 127.0.0.1:3010 (node --watch)
npm run dev:web      # Vite dev-сервер на :5173, проксі /api → :3010
```

Відкрийте `http://localhost:5173`. Збірка `web/dist` для прод-варіанту не потрібна — Vite роздає фронт сам.

## Налаштування (`config.json`)

| Поле | Опис |
| --- | --- |
| `databasePath` | Шлях до живої SQLite-бази CoreProtect (`database.db` плагіна). Відкривається read-only |
| `port` / `host` | Адреса Fastify-сервера (за замовчуванням `127.0.0.1:3010`) |
| `publicOrigin` | Публічний origin; з нього формується OAuth redirect (за замовчуванням `http://localhost:3010`) |
| `defaultLimit` | Максимальна кількість подій для «повного» скану (нормалізується в `1..200000`) |
| `materialNamePrefixesToStrip` | Префікси назв матеріалів, що приховуються (напр. `minecraft:`) |
| `coreProtectTiles` | Параметри tiled-рендера: `tileSize` (16..2048, кратний 16), `maxConcurrentRequests` (1..4), `detailPageSize` (100..20000), `maxTextureSize` |
| `cachePath` | Не використовується (залишено як спадок) |
| `bluemap.*` | Опційна інтеграція: `baseUrl` Bluemap-сервера, шаблон тайлів, `tileSize`, `blocksPerTileAtZoom0`, `lodFactor`, `maxZoom` |
| `discordAuth.*` | `enabled`; `databasePath` (окрема БД auth, за замовчуванням `data/auth.db`); `redirectUri`; `guildId`; `adminRoleId` (роль-адмін, дає доступ до панелі чорного списку); `moderatorRoleIds` (ролі-модератори); `roleCheckIntervalMs` (період перевірки ролей); `sessionMaxAgeMs` (тривалість сесії, за замовчуванням 30 днів) |

## Тести

```bash
cd server && npm test          # бекенд (in-memory SQLite, реальна БД не потрібна)
npm run --prefix web test      # фронтенд-хелпери (Vitest)
```

## Безпека й примітки

- **Read-only гарантія**: бекенд відкриває базу CoreProtect з `readonly: true, fileMustExist: true` — жодна нова функція не пише у вихідні дані.
- **При вимкненій авторизації** (`discordAuth.enabled: false`) API доступний без обмежень (`Access-Control-Allow-Origin: *`) — запускайте інструмент лише локально або в довіреній мережі: координати й активність гравців доступні будь-кому, хто дізнається про порт.
- **Секрети Discord** (`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`) передаються тільки через змінні середовища; `config.json` коммітити не варто (додайте лише `config.example.json`).
- **Дії CoreProtect** закодовані під конкретну схему плагіна: `co_block` (0=break, 1=place, 2=interact, 3=kill/other), `co_container` (0=take, 1=put), `co_item` (0=drop, 1=pickup, 2=throw). За іншої версії плагіна маппінг варто переперевіряти.
- **Фільтр за Y** — точний збіг, не діапазон (карта — плоска top-down проекція).
- Активний завжди один світ; при відсутності/невідповідності `world` відбувається fallback на перший світ із `co_world`.
- Проблема `invalid oauth state` після Discord callback зазвичай означає, що вхід був розпочатий через `127.0.0.1`, а callback повернувся на `localhost` (або навпаки). Видаліть cookies для цієї адреси, відкрийте строго `http://localhost:<port>` та повторіть вхід; не оновлюйте вручну сторінку callback — `state` одноразовий.

## Структура репозиторію

```
/
├─ config.example.json / config.json — конфігурація (шлях до БД, порт, Bluemap, Discord auth, ліміти)
├─ package.json                       — кореневі npm-скрипти (install:all, server, dev:server, dev:web, build:web)
├─ server/
│  ├─ src/index.js     — Fastify app factory `buildApp`, маршрути /api/*, роздача web/dist
│  ├─ src/auth.js      — Discord OAuth (state+PKCE), сесії, перевірка ролей, адмін-API чорного списку
│  ├─ src/auth-db.js   — окремий AuthStore (data/auth.db): oauth_states, sessions, blacklist
│  ├─ src/db.js        — Store: read-only відкриття БД, довідники (світи/гравці/матеріали)
│  ├─ src/queries.js   — SQL-фільтри, снапшоти, keyset-сторінки, aggregate overview
│  ├─ src/config.js    — нормалізація конфігурації
│  └─ test/            — node:test (in-memory SQLite)
├─ web/
│  ├─ src/state.ts / api.ts / ui.ts / main.ts — фільтри, API-клієнт, панель і інспектор
│  ├─ src/colors.ts / tiles.ts / tiled-renderer.ts / map.ts — рендер і Bluemap-шар
│  ├─ src/scan-pipeline.ts — pipeline ручного скану (draft/applied, generation)
│  ├─ test/            — Vitest
│  └─ dist/            — зібраний бандл (створюється `npm run build:web`)
```
