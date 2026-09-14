import './style.css';
import type { Filters, TimeSelection, BBox } from './state';
import { calculateEffectiveTime, defaultFilters } from './state';
import { MapView } from './map';
import { BluemapLayer } from './tiles';
import { buildFilterPanel, buildLegend, type ScanControls } from './ui';
import { apiAggregate, apiConfig, apiEvent, apiMeta, apiQueryPage, apiQueryPlan, apiRefreshMeta, type ApiConfig, type CpEvent, type MetaData, type SourceSnapshot } from './api';
import { ACTION_LABELS, eventColor, rgbHex } from './colors';
import { dedupeEvents, distributeEventsByTile, sortOccupiedTiles, tileBounds, tileKey } from './tile-utils';
import { DetailQueueSession, DetailTileQueue, ManualScanOrchestrator } from './scan-pipeline';

interface AppliedRequest { filters: Filters; center: { x: number; z: number; scale: number }; config: ApiConfig; snapshot: SourceSnapshot; generation: number; aggregateTotal?: number; aggregateTileTotal?: number; }
const $ = (id: string) => document.getElementById(id)!;
const filtersEl = $('filters'), inspectorEl = $('inspector'), tooltipEl = $('tooltip') as HTMLDivElement, statusEl = $('statusbar'), legendEl = $('legend'), hudEl = $('world-hud');
let draftFilters: Filters = defaultFilters(), draftTime: TimeSelection = { mode: 'default', from: null, to: null };
let meta: MetaData = { worlds: [], users: [], materials: [], actions: [] };
let config: ApiConfig, map: MapView, bluemap: BluemapLayer, appliedRequest: AppliedRequest | null = null, controller: AbortController | null = null;
const scan = new ManualScanOrchestrator();
let generation = 0, dirty = false, status = 'Натисніть «Оновити дані»', rangeError: string | null = null, resultBounds: BBox | null = null, loading = false, stopped = false, bluemapOpacity = 0.9, lodMarkersVisible = true, detailPriority: ((key: string) => void) | null = null;
let detailSession: DetailQueueSession | null = null, detailRun: Promise<void> | null = null;
const detailSingleRuns = new Set<Promise<void>>();
let inspectorRequest = 0;
let cursorX: number | null = null, cursorZ: number | null = null;
let loadingStartedAt: number | null = null, loadingTimer: number | null = null;

function cloneFilters(filters: Filters): Filters { return { ...filters, bbox: filters.bbox && { ...filters.bbox }, users: [...filters.users], actions: [...filters.actions], materials: [...filters.materials] }; }
function isCurrent(request: AppliedRequest) { return appliedRequest?.generation === request.generation && !controller?.signal.aborted; }
function controls(): ScanControls { return { status, error: rangeError, canShowAll: !!resultBounds, canStop: loading || (!!detailSession && !detailSession.isStopped), canContinueDetails: !!detailSession?.isPaused, bluemapOpacity, lodMarkersVisible, onBluemapOpacity: alpha => { bluemapOpacity = alpha; bluemap?.setOpacity(alpha); }, onLodMarkersVisible: enabled => { lodMarkersVisible = enabled; map?.setLodMarkersVisible(enabled); }, onApply: apply, onStop: stop, onContinueDetails: startMassDetails, onShowAll: () => resultBounds && map.fitToResults(resultBounds) }; }
function rebuild() { buildFilterPanel(filtersEl, draftFilters, draftTime, meta, onFiltersChanged, onTimeChanged, controls()); buildLegend(legendEl, draftFilters, meta); }
function formatElapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function renderStatus() {
  const elapsed = loadingStartedAt == null ? '' : ` · ${formatElapsed(Date.now() - loadingStartedAt)}`;
  statusEl.textContent = `${status}${elapsed}`;
}
// Секундомір оновлює лише рядок стану, не перебудовуючи панель фільтрів щосекунди.
function setLoading(value: boolean) {
  if (loading === value) return;
  loading = value;
  if (value) {
    loadingStartedAt = Date.now();
    loadingTimer = window.setInterval(renderStatus, 1000);
  } else {
    loadingStartedAt = null;
    if (loadingTimer != null) window.clearInterval(loadingTimer);
    loadingTimer = null;
  }
  renderStatus();
}
function showStatus(text: string, warning = false) { status = text; renderStatus(); statusEl.style.color = warning ? '#ff8a80' : 'var(--muted)'; rebuild(); }
function markDirty() { scan.markDirty(); dirty = scan.dirty; if (!loading) showStatus('Є незастосовані зміни · Ctrl+Enter'); else rebuild(); }
function onFiltersChanged(patch: Partial<Filters>) { Object.assign(draftFilters, patch); if (patch.world && bluemap) { bluemap.setWorld(draftFilters.world); updateHud(); } markDirty(); }
function onTimeChanged(time: TimeSelection) { draftTime = time; rangeError = null; markDirty(); }
function updateHud() {
  const coordinates = cursorX == null || cursorZ == null
    ? 'X: — Z: —'
    : `X: ${Math.floor(cursorX)} Z: ${Math.floor(cursorZ)}`;
  hudEl.textContent = `Світ: ${draftFilters.world}${appliedRequest && appliedRequest.filters.world !== draftFilters.world ? ` · показані дані: ${appliedRequest.filters.world}` : ''} · ${coordinates} · масштаб 1:${(1 / map.cam.scale).toFixed(1)}`;
}
function onCamera(scale: number, cx: number, cz: number) { updateHud(); if (!bluemap) return; const w = map.app.renderer.width / scale, h = map.app.renderer.height / scale; bluemap.update({ x1: cx - w / 2, z1: cz - h / 2, x2: cx + w / 2, z2: cz + h / 2, pxPerBlock: scale }); }
function onCursorMove(x: number, z: number) {
  cursorX = Number.isFinite(x) ? x : null;
  cursorZ = Number.isFinite(z) ? z : null;
  updateHud();
}
// Detail tiles may arrive after a draft edit, so raster colors use the applied snapshot.
function colorContext(filters: Filters = draftFilters) { return { mode: filters.mode, mix: filters.mix, tMin: 0, tMax: 1 }; }
function abortError(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }

async function fetchAll(request: AppliedRequest) { const all: CpEvent[] = []; let cursor: string | null = null; do { const page = await apiQueryPage(request.filters, { snapshot: request.snapshot, cursor, pageSize: request.config.coreProtectTiles.detailPageSize }, controller!.signal); if (!isCurrent(request)) return []; all.push(...page.events); cursor = page.nextCursor; } while (cursor); return dedupeEvents(all); }
async function loadDetailTile(request: AppliedRequest, key: string) { const [tx, tz] = key.split(':').map(Number), b = tileBounds({ x: tx, z: tz }, request.config.coreProtectTiles.tileSize); const events: CpEvent[] = []; let cursor: string | null = null; do { const page = await apiQueryPage(request.filters, { snapshot: request.snapshot, cursor, pageSize: request.config.coreProtectTiles.detailPageSize, tile: { xMin: b.x1, xMaxExclusive: b.x2, zMin: b.z1, zMaxExclusive: b.z2 } }, controller!.signal); if (!isCurrent(request)) return false; events.push(...page.events); cursor = page.nextCursor; } while (cursor); return isCurrent(request) && map.installEventTile(request.generation, key, dedupeEvents(events), colorContext(request.filters)); }
function detailProgress(request: AppliedRequest) {
  return `${detailSession?.loadedCount ?? 0}/${request.aggregateTileTotal ?? 0} плиток · ${aggregateTotal(request)} подій`;
}
function startMassDetails() {
  const session = detailSession, request = appliedRequest;
  if (!session || !request || !isCurrent(request) || detailRun) return;
  if (!session.startMass()) return;
  const total = request.aggregateTileTotal ?? session.queue.size;
  let partial = 0;
  setLoading(true);
  showStatus('Завантажується деталізація…');
  let run: Promise<void>;
  run = (async () => {
    const worker = async () => { while (isCurrent(request) && !session.isStopped) { const key = session.takeMass(); if (!key) return; let installed = false; try { installed = await loadDetailTile(request, key); } catch (error) { if (!abortError(error)) partial++; } finally { session.queue.complete(key, installed); if (isCurrent(request) && !session.isStopped) showStatus(`${partial ? 'Часткові помилки · ' : ''}деталізація: ${detailProgress(request)}`); } } };
    await Promise.all(Array.from({ length: Math.min(session.workerCap, total) }, worker));
    if (isCurrent(request) && !session.isStopped) showStatus(`${partial ? 'Часткові помилки; ' : ''}деталізацію завершено: ${detailProgress(request)}`, partial > 0);
  })().finally(() => { if (detailRun === run) detailRun = null; if (isCurrent(request)) { setLoading(false); rebuild(); } });
  detailRun = run;
}
function startSingleDetail(key: string) {
  const session = detailSession, request = appliedRequest;
  if (!session || !request || !isCurrent(request)) return;
  const action = session.startSingle(key);
  if (action === 'prioritized') { showStatus('Одну ділянку деталізації додано до черги з пріоритетом'); return; }
  if (action !== 'started') return;
  setLoading(true);
  showStatus('Завантажується деталізація однієї ділянки…');
  let run: Promise<void>;
  run = (async () => {
    let installed = false;
    try { installed = await loadDetailTile(request, key); }
    catch (error) { if (!abortError(error) && isCurrent(request)) showStatus(`Помилка деталізації однієї ділянки: ${String(error)}`, true); }
    finally {
      session.queue.complete(key, installed);
      if (isCurrent(request) && !session.isStopped && installed) showStatus(`Деталізацію однієї ділянки завантажено: ${detailProgress(request)}`);
    }
  })().finally(() => {
    detailSingleRuns.delete(run);
    if (isCurrent(request) && !detailRun && detailSingleRuns.size === 0) { setLoading(false); rebuild(); }
  });
  detailSingleRuns.add(run);
}
function aggregateTotal(request: AppliedRequest) { return request.aggregateTotal ?? 0; }
async function apply() {
  const effective = calculateEffectiveTime(draftTime, Math.floor(Date.now() / 1000)); if (effective.error) { rangeError = effective.error; rebuild(); return; }
  rangeError = null; detailSession?.stop(); detailSession = null; detailRun = null; detailSingleRuns.clear(); controller?.abort(); controller = new AbortController(); const signal = controller.signal; const filters = cloneFilters(draftFilters); filters.tFrom = effective.from; filters.tTo = effective.to; const localGeneration = scan.start(); generation = localGeneration; setLoading(true); stopped = false; dirty = scan.dirty; showStatus('Оновлення метаданих…');
  try {
    meta = await apiRefreshMeta(signal); if (signal.aborted || localGeneration !== generation) return; showStatus('Перевірка обсягу даних…'); const plan = await apiQueryPlan(filters, undefined, signal); if (signal.aborted || localGeneration !== generation) return; const request: AppliedRequest = { filters, center: { x: map.cam.cx, z: map.cam.cz, scale: map.cam.scale }, config, snapshot: plan.snapshot, generation: localGeneration }; appliedRequest = request;
    if (plan.strategy === 'all') { const events = await fetchAll(request); if (!isCurrent(request)) return; const groups = distributeEventsByTile(events, config.coreProtectTiles.tileSize); map.beginDataGeneration(localGeneration); for (const [key, tileEvents] of groups) map.setEventTile(localGeneration, key, tileEvents, colorContext(request.filters)); if (!isCurrent(request) || !map.commitDataGeneration(localGeneration)) return; resultBounds = plan.bounds ?? (events.length ? { x1: Math.min(...events.map(e => e.x)), x2: Math.max(...events.map(e => e.x)), z1: Math.min(...events.map(e => e.z)), z2: Math.max(...events.map(e => e.z)) } : null); showStatus(`${plan.totalExact ? events.length : `>${plan.threshold}`} подій завантажено`); return; }
    showStatus('Побудова огляду…'); const aggregate = await apiAggregate(filters, request.snapshot, config.coreProtectTiles.tileSize, signal); if (!isCurrent(request)) return; const grouped = new Map<string, typeof aggregate.chunks>(); for (const chunk of aggregate.chunks) { const key = tileKey({ x: Math.floor(chunk.cx * 16 / config.coreProtectTiles.tileSize), z: Math.floor(chunk.cz * 16 / config.coreProtectTiles.tileSize) }); const group = grouped.get(key); if (group) group.push(chunk); else grouped.set(key, [chunk]); } map.beginDataGeneration(localGeneration); for (const [key, chunks] of grouped) map.setAggregateTile(localGeneration, key, chunks, colorContext(request.filters)); if (!map.commitDataGeneration(localGeneration)) return;
    resultBounds = aggregate.bbox; const occupied = aggregate.occupiedTiles.map(tile => ({ x: tile.tx, z: tile.tz })); const queue = new DetailTileQueue(sortOccupiedTiles(occupied, { x: Math.floor(request.center.x / config.coreProtectTiles.tileSize), z: Math.floor(request.center.z / config.coreProtectTiles.tileSize) }).map(tileKey)); request.aggregateTotal = aggregate.total; request.aggregateTileTotal = queue.size; detailSession = new DetailQueueSession(queue, config.coreProtectTiles.maxConcurrentRequests); detailPriority = startSingleDetail;
    setLoading(false);
    showStatus(`Огляд повністю завантажено: ${aggregate.total} подій. Масова деталізація запускається лише кнопкою «Продовжити деталізацію»; масштаб змінює лише вигляд.`);
    return;
  } catch (error) { if (!abortError(error) && !signal.aborted) showStatus(`Помилка; попередня карта збережена: ${String(error)}`, true); } finally { if (localGeneration === generation && !detailRun) { setLoading(false); rebuild(); } }
}
function stop() { stopped = true; detailSession?.stop(); detailPriority = null; scan.stop(generation); controller?.abort(); setLoading(false); showStatus('Зупинено: огляд і завантажені деталі збережено'); }
// Coordinates from Pixi are viewport-relative, while the tooltip is positioned inside #map-wrap.
function onHover(events: CpEvent[] | null, sx: number, sy: number) {
  if (!events?.length) { tooltipEl.style.display = 'none'; return; }

  const context = colorContext(appliedRequest?.filters ?? draftFilters);
  const visibleEvents = events.slice(0, 6);
  const fragment = document.createDocumentFragment();
  for (const event of visibleEvents) {
    const item = inspectorElement('div'); item.className = 'ev';
    const swatch = inspectorElement('span'); swatch.className = 'swatch';
    swatch.style.background = rgbHex(eventColor(event, context));
    const nick = inspectorElement('b', event.nick ?? '?'); nick.className = 'nick';
    const details = inspectorElement('span', ` · ${eventActionLabel(event)} · ${event.material ?? '—'} · ${localTime(event.time)}`);
    details.className = 'tiny';
    item.append(swatch, nick, details);
    fragment.append(item);
  }
  if (events.length > visibleEvents.length) {
    const more = inspectorElement('div', `…ще ${events.length - visibleEvents.length} в цьому блоці`);
    more.className = 'tiny';
    fragment.append(more);
  }
  tooltipEl.replaceChildren(fragment);
  tooltipEl.style.display = 'block';

  const mapRect = $('map-wrap').getBoundingClientRect();
  const margin = 8;
  tooltipEl.style.left = `${Math.max(margin, Math.min(sx - mapRect.left + 14, mapRect.width - tooltipEl.offsetWidth - margin))}px`;
  tooltipEl.style.top = `${Math.max(margin, Math.min(sy - mapRect.top + 14, mapRect.height - tooltipEl.offsetHeight - margin))}px`;
}
function inspectorElement<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  return element;
}
function eventActionLabel(event: CpEvent) { return ACTION_LABELS[`${event.src}:${event.action}`] ?? `Дія ${event.src}:${event.action}`; }
function localTime(epochSeconds: number) { return new Date(epochSeconds * 1000).toLocaleString('ru-RU'); }
function closeInspector() { inspectorRequest++; inspectorEl.classList.remove('open'); inspectorEl.replaceChildren(); }
function inspectorRow(label: string, value: string, small = false) {
  const row = inspectorElement('div'); row.className = 'kv';
  const key = inspectorElement('span', label); key.className = 'k';
  const content = inspectorElement('span', value);
  if (small) content.className = 'tiny inspector-value';
  row.append(key, content);
  return row;
}
async function copyTeleport(button: HTMLButtonElement, event: CpEvent) {
  const command = `/tp ${event.x} ${event.y} ${event.z}`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable');
    await navigator.clipboard.writeText(command);
    button.textContent = 'Скопійовано';
  } catch {
    button.textContent = 'Буфер недоступний';
    button.title = command;
  }
}
function sameEvent(left: CpEvent, right: CpEvent) { return left.src === right.src && left.rowid_src === right.rowid_src; }
function eventListLabel(event: CpEvent) {
  return `${event.nick ?? '?'} · ${eventActionLabel(event)} · ${event.material ?? '—'} · ${localTime(event.time)}`;
}
function renderInspector(event: CpEvent, nearby: CpEvent[], blockEvents: CpEvent[]) {
  inspectorEl.replaceChildren();
  const heading = inspectorElement('div'); heading.className = 'row inspector-heading';
  const title = inspectorElement('h3', 'Подія'); title.className = 'inspector-title';
  const close = inspectorElement('button', '✕'); close.type = 'button'; close.title = 'Закрити інспектор'; close.addEventListener('click', closeInspector);
  heading.append(title, close);

  const card = inspectorElement('div'); card.className = 'card';
  const player = inspectorElement('h4', event.nick ?? '?');
  card.append(player, inspectorRow('Дія', eventActionLabel(event)), inspectorRow('Блок', event.material ?? '—'));
  if (event.amount != null) card.append(inspectorRow('Кількість', String(event.amount)));
  card.append(
    inspectorRow('Координати', `${event.x} / ${event.y} / ${event.z}`),
    inspectorRow('Світ', event.world),
    inspectorRow('Час', localTime(event.time)),
    inspectorRow('Відкочено (rollback)', event.rolled_back ? 'так' : 'ні'),
    inspectorRow('UUID', event.uuid ?? '—', true),
  );

  const actions = inspectorElement('div'); actions.className = 'row inspector-actions';
  const filterPlayer = inspectorElement('button', 'Фільтр: гравець'); filterPlayer.type = 'button';
  filterPlayer.addEventListener('click', () => onFiltersChanged({ users: event.nick ? [event.nick] : [], usersExcl: false }));
  const copy = inspectorElement('button', 'Копіювати /tp'); copy.type = 'button';
  copy.addEventListener('click', () => void copyTeleport(copy, event));
  actions.append(filterPlayer, copy);

  // Усі події в точці вже завантажено разом із плиткою карти, тому їх
  // можна вибирати без повторного клацання перекритих маркерів.
  const blockHeading = inspectorElement('h3', `Події в блоці (${event.x}, ${event.z}) · ${blockEvents.length}`);
  const blockCard = inspectorElement('div'); blockCard.className = 'card block-events';
  for (const blockEvent of [...blockEvents].sort((left, right) => right.time - left.time || right.rowid_src - left.rowid_src)) {
    const item = inspectorElement('button', eventListLabel(blockEvent));
    item.type = 'button'; item.className = 'block-event-item';
    if (sameEvent(blockEvent, event)) {
      item.classList.add('active');
      item.setAttribute('aria-current', 'true');
    } else {
      item.addEventListener('click', () => void showInspectorEvent(blockEvent, blockEvents));
    }
    blockCard.append(item);
  }

  const nearbyHeading = inspectorElement('h3', 'Останні дії поруч (усі гравці, ±1 год, 16 блоків)');
  const nearbyCard = inspectorElement('div'); nearbyCard.className = 'card nearby-events';
  if (!nearby.length) {
    const empty = inspectorElement('span', 'немає даних'); empty.className = 'tiny'; nearbyCard.append(empty);
  } else {
    for (const nearbyEvent of nearby) {
      const item = inspectorElement('div'); item.className = 'nearby-item';
      const actor = inspectorElement('div', `Гравець: ${nearbyEvent.nick ?? 'невідомо'}`); actor.className = 'nearby-actor';
      const details = inspectorElement('div', `${eventActionLabel(nearbyEvent)} · ${nearbyEvent.material ?? '—'} · ${nearbyEvent.x}, ${nearbyEvent.y}, ${nearbyEvent.z} · ${new Date(nearbyEvent.time * 1000).toLocaleTimeString('ru-RU')}`);
      details.className = 'nearby-details';
      item.append(actor, details);
      nearbyCard.append(item);
    }
  }
  inspectorEl.append(heading, card, actions, blockHeading, blockCard, nearbyHeading, nearbyCard);
}
async function showInspectorEvent(event: CpEvent, blockEvents: CpEvent[]) {
  const request = ++inspectorRequest;
  inspectorEl.classList.add('open'); inspectorEl.replaceChildren();
  const loadingMessage = inspectorElement('div', 'Завантаження…'); loadingMessage.className = 'tiny';
  inspectorEl.append(loadingMessage);
  try {
    const detail = await apiEvent(event.src, event.rowid_src);
    if (request !== inspectorRequest) return;
    renderInspector(detail.event, detail.nearby, blockEvents);
  } catch {
    if (request !== inspectorRequest) return;
    inspectorEl.replaceChildren();
    const message = inspectorElement('div', 'Не вдалося завантажити подію'); message.className = 'tiny';
    const close = inspectorElement('button', 'Закрити'); close.type = 'button'; close.addEventListener('click', closeInspector);
    inspectorEl.append(message, close);
  }
}
async function onClick(events: CpEvent[]) {
  if (!events.length) { closeInspector(); return; }
  await showInspectorEvent(events.at(-1)!, events);
}
async function boot() { config = await apiConfig(); draftFilters = defaultFilters(config.defaultLimit); meta = await apiMeta(); if (!meta.worlds.some(world => world.world === draftFilters.world)) draftFilters.world = meta.worlds[0]?.world ?? draftFilters.world; map = new MapView($('map'), { onHover, onClick, onSelection: bbox => { draftFilters.bbox = bbox; markDirty(); }, onCameraChange: onCamera, onCursorMove, onPrioritizeTile: key => detailPriority?.(key) }, config.coreProtectTiles); await map.ready; map.setLodMarkersVisible(lodMarkersVisible); bluemap = new BluemapLayer(config.bluemap as never); map.world.addChildAt(bluemap.container, 0); bluemap.setOpacity(bluemapOpacity); bluemap.setWorld(draftFilters.world); updateHud(); rebuild(); showStatus('Натисніть «Оновити дані»'); window.addEventListener('keydown', event => { if (!event.repeat && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void apply(); } }); }
void boot();
/* obsolete implementation removed
import './style.css';
import type { Filters } from './state';
import { defaultFilters } from './state';
import { MapView } from './map';
import { BluemapLayer } from './tiles';
import { buildFilterPanel, buildLegend, type MetaData } from './ui';
import { apiQuery, apiAggregate, apiMeta, apiEvent, apiSyncStatus, type CpEvent } from './api';
import { eventColor, rgbHex, ACTION_LABELS, uuidColor } from './colors';

const filters: Filters = defaultFilters();
let meta: MetaData | null = null;
let map: MapView;
let bluemap: BluemapLayer;
let tMin = 0, tMax = 1;
let refreshTimer: number | undefined;

// --- DOM ---
const $ = (id: string) => document.getElementById(id)!;
const filtersEl = $('filters'), inspectorEl = $('inspector'),
  tooltipEl = $('tooltip') as HTMLDivElement, statusEl = $('statusbar'),
  legendEl = $('legend'), hudEl = $('world-hud');

async function refresh() {
  const overview = map.cam.scale <= 5; // LOD: далеко — агрегаты по чанкам
  const ctx = { mode: filters.mode, mix: filters.mix, tMin, tMax };
  try {
    if (overview) {
      // Не агрегируем всю таблицу CoreProtect (она может содержать миллионы
      // строк). На обзорном LOD достаточно области вокруг текущего viewport.
      // Ограничение особенно важно на минимальном масштабе, где viewport
      // покрывает десятки тысяч блоков.
      const rw = map.app.renderer?.width || window.innerWidth;
      const rh = map.app.renderer?.height || window.innerHeight;
      const maxSide = 4096;
      const visibleW = Math.min(rw / map.cam.scale, maxSide);
      const visibleH = Math.min(rh / map.cam.scale, maxSide);
      const aggregateFilters: Filters = {
        ...filters,
        bbox: {
          x1: map.cam.cx - visibleW / 2,
          x2: map.cam.cx + visibleW / 2,
          z1: map.cam.cz - visibleH / 2,
          z2: map.cam.cz + visibleH / 2,
        },
      };
      const { chunks, elapsedMs } = await apiAggregate(aggregateFilters);
      map.setChunks(chunks, ctx);
      setStatus(`агрегаты: ${chunks.length} чанков · ${elapsedMs} мс · область до ${maxSide}×${maxSide} блоков`, false);
    } else {
      // в детальном режиме подгружаем только видимую область + margin
      const rw = map.app.renderer?.width || window.innerWidth;
      const rh = map.app.renderer?.height || window.innerHeight;
      const w = rw / map.cam.scale, h = rh / map.cam.scale;
      const m = 64;
      const q: Filters = {
        ...filters,
        bbox: filters.bbox ?? {
          x1: map.cam.cx - w / 2 - m, x2: map.cam.cx + w / 2 + m,
          z1: map.cam.cz - h / 2 - m, z2: map.cam.cz + h / 2 + m,
        },
      };
      const res = await apiQuery(q);
      if (res.events.length) {
        tMin = Math.min(...res.events.map(e => e.time));
        tMax = Math.max(...res.events.map(e => e.time));
        if (tMax === tMin) tMax = tMin + 1;
        ctx.tMin = tMin; ctx.tMax = tMax;
      }
      map.setEvents(res.events, ctx);
      setStatus(`${res.count} событий${res.truncated ? ' (обрезано лимитом)' : ''} · ${res.elapsedMs} мс`, res.truncated);
    }
    buildLegend(legendEl, filters, meta!);
  } catch (e) {
    setStatus(`ошибка: ${e}`, true);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refresh, 300);
}

function setStatus(text: string, warn: boolean) {
  statusEl.textContent = text;
  statusEl.style.color = warn ? '#ff8a80' : 'var(--muted)';
}

function onFiltersChanged(patch: Partial<Filters>) {
  Object.assign(filters, patch);
  buildFilterPanel(filtersEl, filters, meta!, onFiltersChanged, refresh);
  scheduleRefresh();
}

function onCamera(scale: number, cx: number, cz: number) {
  const zoomEl = $('hud-zoom');
  if (zoomEl) {
    // scale — это пикселей на блок, поэтому при отдалении значение вторая
    // часть масштаба должна расти, а не уменьшаться.
    zoomEl.textContent = `1:${(1 / scale).toFixed(1)}`;
  }
  if (!bluemap) return;
  const w = map.app.renderer.width / scale, h = map.app.renderer.height / scale;
  bluemap.update({ x1: cx - w / 2, z1: cz - h / 2, x2: cx + w / 2, z2: cz + h / 2, pxPerBlock: scale });
  const wantOverview = scale < 3;
  if (wantOverview !== (map.getMode() === 'aggregate') || wantOverview) scheduleRefresh();
}

// --- Hover / Tooltip ---
function onHover(evs: CpEvent[] | null, sx: number, sy: number) {
  if (!evs || !evs.length) { tooltipEl.style.display = 'none'; return; }
  const ctx = { mode: filters.mode, mix: filters.mix, tMin, tMax };
  const items = evs.slice(0, 6).map(e => {
    const label = ACTION_LABELS[`${e.src}:${e.action}`] ?? e.src;
    return `<div class="ev" data-src="${e.src}" data-rowid="${e.rowid_src}">
      <span class="swatch" style="background:${rgbHex(eventColor(e, ctx))}"></span>
      <b>${e.nick ?? '?'}</b> · ${label} · ${e.material?.replace('minecraft:', '') ?? ''}
      · <span class="tiny">${new Date(e.time * 1000).toLocaleString('ru-RU')}</span></div>`;
  }).join('');
  tooltipEl.innerHTML = evs.length > 6
    ? `${items}<div class="tiny">…ещё ${evs.length - 6} в этом блоке</div>` : items;
  tooltipEl.style.display = 'block';
  const r = $('map-wrap').getBoundingClientRect();
  tooltipEl.style.left = Math.min(sx - r.left + 14, r.width - 340) + 'px';
  tooltipEl.style.top = (sy - r.top + 14) + 'px';
  tooltipEl.querySelectorAll<HTMLElement>('.ev').forEach(n => {
    n.onclick = () => openInspector(n.dataset.src!, +n.dataset.rowid!);
  });
}

async function onClick(evs: CpEvent[]) {
  if (!evs.length) { inspectorEl.classList.remove('open'); return; }
  const e = evs[evs.length - 1]; // самое доступное — верхнее
  openInspector(e.src, e.rowid_src);
}

async function openInspector(src: string, rowid: number) {
  inspectorEl.classList.add('open');
  inspectorEl.innerHTML = `<div class="tiny">загрузка…</div>`;
  try {
    const { event: ev, nearby } = await apiEvent(src, rowid);
    const label = ACTION_LABELS[`${ev.src}:${ev.action}`] ?? `${ev.src}:${ev.action}`;
    const color = rgbHex(uuidColor(ev.uuid, ev.nick));
    inspectorEl.innerHTML = `
      <div class="row"><h3 style="flex:1">Событие</h3><button id="ins-close">✕</button></div>
      <div class="card">
        <h4><span class="dot" style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${color}"></span> ${ev.nick ?? '?'}</h4>
        <div class="kv"><span class="k">Действие</span><span>${label}</span></div>
        <div class="kv"><span class="k">Блок</span><span>${ev.material?.replace('minecraft:', '') ?? '—'}</span></div>
        ${ev.amount != null ? `<div class="kv"><span class="k">Кол-во</span><span>${ev.amount}</span></div>` : ''}
        <div class="kv"><span class="k">Координаты</span><span>${ev.x} / ${ev.y} / ${ev.z}</span></div>
        <div class="kv"><span class="k">Мир</span><span>${ev.world}</span></div>
        <div class="kv"><span class="k">Время</span><span>${new Date(ev.time * 1000).toLocaleString('ru-RU')}</span></div>
        <div class="kv"><span class="k">Откачено (rollback)</span><span>${ev.rolled_back ? 'да' : 'нет'}</span></div>
        <div class="kv"><span class="k">UUID</span><span class="tiny">${ev.uuid ?? '—'}</span></div>
      </div>
      <div class="row">
        <button id="f-user">Фильтр: игрок</button>
        <button id="f-teleport">Копировать /tp</button>
      </div>
      <h3>Рядом (тот же игрок, ±1ч, 16 блоков)</h3>
      <div class="card">
        ${nearby.map(n => `<div class="nearby-item">${ACTION_LABELS[`${n.src}:${n.action}`] ?? n.src}
          ${n.material?.replace('minecraft:', '') ?? ''} · ${n.x},${n.y},${n.z}
          · <span class="tiny">${new Date(n.time * 1000).toLocaleTimeString('ru-RU')}</span></div>`).join('') || '<span class="tiny">нет данных</span>'}
      </div>`;
    (inspectorEl.querySelector('#ins-close') as HTMLButtonElement).onclick = () => inspectorEl.classList.remove('open');
    (inspectorEl.querySelector('#f-user') as HTMLButtonElement).onclick = () =>
      onFiltersChanged({ users: [ev.nick ?? ''].filter(Boolean), usersExcl: false });
    (inspectorEl.querySelector('#f-teleport') as HTMLButtonElement).onclick = () =>
      navigator.clipboard?.writeText(`/tp ${ev.x} ${ev.y} ${ev.z}`);
  } catch (e) {
    inspectorEl.innerHTML = `<div class="tiny">ошибка: ${e}</div>`;
  }
}

// --- Boot ---
async function boot() {
  map = new MapView($('map'), {
    onHover, onClick,
    onSelection: bbox => {
      filters.bbox = bbox;
      buildFilterPanel(filtersEl, filters, meta!, onFiltersChanged, refresh);
      refresh();
    },
    onCameraChange: onCamera,
    onCursorMove: (bx, bz) => {
      const hudX = $('hud-x');
      const hudZ = $('hud-z');
      if (hudX && hudZ) {
        if (isNaN(bx) || isNaN(bz)) {
          hudX.textContent = '—';
          hudZ.textContent = '—';
        } else {
          hudX.textContent = Math.floor(bx).toString();
          hudZ.textContent = Math.floor(bz).toString();
        }
      }
    }
  });
  await map.ready;

  // Bluemap подложка из конфига сервера
  let bluemapCfg: any = { enabled: false, baseUrl: '', tileTemplate: '', tileSize: 512, blocksPerTileAtZoom0: 512, maxZoom: 5 };
  try {
    const cr = await fetch('/api/config');
    if (cr.ok) { const c = await cr.json(); if (c.bluemap) bluemapCfg = c.bluemap; }
  } catch { }
  bluemap = new BluemapLayer(bluemapCfg);
  map.world.addChildAt(bluemap.container, 0);

  try {
    meta = await apiMeta();
  } catch {
    meta = { worlds: [{ id: 1, world: 'world' }], users: [], materials: [], actions: [] };
  }

  // Идентификатор карты Bluemap совпадает с именем мира в CoreProtect.
  bluemap.setWorld(filters.world);

  buildFilterPanel(filtersEl, filters, meta, onFiltersChanged, refresh);
  hudEl.innerHTML = `Мир: <b>${filters.world}</b> · X: <span id="hud-x">—</span> Z: <span id="hud-z">—</span> · масштаб <span id="hud-zoom"></span>`;
  refresh();

  // прогресс первичного sync
  const pollSync = async () => {
    const s = await apiSyncStatus();
    if (s.running) {
      const total = Object.values(s.sources).reduce((a: number, x: any) => a + x.rows, 0);
      setStatus(`первичный sync: ${total.toLocaleString('ru-RU')} строк…`, false);
      setTimeout(pollSync, 2000);
    }
  };
  pollSync();
}

boot();
*/
