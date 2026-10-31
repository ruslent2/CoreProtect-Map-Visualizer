import i18n, { t } from './i18n';
import './style.css';
import type { EventViewFilter, Filters, TimeSelection, BBox } from './state';
import { calculateEffectiveTime, defaultFilters, NO_EVENT_VIEW_FILTER, sameYRange } from './state';
import { MapView } from './map';
import { BluemapLayer } from './tiles';
import { XaeroOverlayLayer } from './xaero-overlay';
import { buildFilterPanel, buildLegend, type ScanControls } from './ui';
import { enhanceSelect } from './dropdown';
import {
  apiAggregate,
  apiAuthMe,
  apiBlacklist,
  apiBlockUser,
  apiConfig,
  apiEvent,
  apiLogout,
  apiMeta,
  apiQueryPage,
  apiQueryPlan,
  apiRefreshMeta,
  apiUnblockUser,
  type ApiConfig,
  type AuthUser,
  type CpEvent,
  type MetaData,
  type SourceSnapshot,
} from './api';
import { actionLabel, eventColor, rgbHex } from './colors';
import { dedupeEvents, distributeEventsByTile, sortOccupiedTiles, tileBounds, tileKey } from './tile-utils';
import { DetailQueueSession, DetailTileQueue, ManualScanOrchestrator } from './scan-pipeline';

interface AppliedRequest {
  filters: Filters;
  center: { x: number; z: number; scale: number };
  config: ApiConfig;
  snapshot: SourceSnapshot;
  generation: number;
  aggregateTotal?: number;
  aggregateTileTotal?: number;
}

// --- Shared application state ---
const $ = (id: string) => document.getElementById(id)!;
const filtersEl = $('filters');
const inspectorEl = $('inspector');
const tooltipEl = $('tooltip') as HTMLDivElement;
const statusEl = $('statusbar');
const legendEl = $('legend');
const hudEl = $('world-hud');

let draftFilters: Filters = defaultFilters();
let draftTime: TimeSelection = { mode: 'default', from: null, to: null };
let meta: MetaData = { worlds: [], users: [], materials: [], actions: [] };
let config: ApiConfig;
let map: MapView;
let bluemap: BluemapLayer;
let appliedRequest: AppliedRequest | null = null;
let controller: AbortController | null = null;
const scan = new ManualScanOrchestrator();
let generation = 0;
let dirty = false;
let status = t('status.initial');
let rangeError: string | null = null;
let resultBounds: BBox | null = null;
let loading = false;
let bluemapOpacity = 0.9;
let xaero: XaeroOverlayLayer;
let lodMarkersVisible = true;
let detailPriority: ((key: string) => void) | null = null;
let detailSession: DetailQueueSession | null = null,
  detailRun: Promise<void> | null = null;
const detailSingleRuns = new Set<Promise<void>>();
let inspectorRequest = 0;
let cursorX: number | null = null;
let cursorZ: number | null = null;
let loadingStartedAt: number | null = null;
let loadingTimer: number | null = null;
let resultUsers: { nick: string | null; uuid: string | null }[] | null = null;

function cloneFilters(filters: Filters): Filters {
  return {
    ...filters,
    bbox: filters.bbox && { ...filters.bbox },
    y: filters.y && { ...filters.y },
    users: [...filters.users],
    actions: [...filters.actions],
    materials: [...filters.materials],
  };
}

function isCurrent(request: AppliedRequest) {
  return appliedRequest?.generation === request.generation && !controller?.signal.aborted;
}

// Build callbacks and flags consumed by the filter panel.
function controls(): ScanControls {
  return {
    status,
    error: rangeError,
    canShowAll: !!resultBounds,
    canStop: loading || (!!detailSession && !detailSession.isStopped),
    canContinueDetails: !!detailSession?.isPaused,
    canLiveY: canLiveY(),
    bluemapOpacity,
    lodMarkersVisible,
    onBluemapOpacity: (alpha) => {
      bluemapOpacity = alpha;
      bluemap?.setOpacity(alpha);
      xaero?.setOpacity(alpha);
    },
    onLodMarkersVisible: (enabled) => {
      lodMarkersVisible = enabled;
      map?.setLodMarkersVisible(enabled);
    },
    onApply: apply,
    onStop: stop,
    onContinueDetails: startMassDetails,
    onShowAll: () => resultBounds && map.fitToResults(resultBounds),
  };
}
let deferredFilterRebuild = false;
function rebuild() {
  const active = document.activeElement;
  // Асинхронні статуси також можуть спричинити перебудову, тому відкладаємо її,
  // доки користувач редагує нативне поле дати й часу.
  if (
    active instanceof HTMLInputElement &&
    active.matches('[data-preserve-on-rebuild]') &&
    filtersEl.contains(active)
  ) {
    if (!deferredFilterRebuild) {
      deferredFilterRebuild = true;
      active.addEventListener(
        'blur',
        () =>
          window.setTimeout(() => {
            deferredFilterRebuild = false;
            rebuild();
          }, 0),
        { once: true },
      );
    }
    buildLegend(legendEl, appliedRequest?.filters ?? draftFilters, resultUsers);
    return;
  }
  deferredFilterRebuild = false;
  buildFilterPanel(filtersEl, draftFilters, draftTime, meta, onFiltersChanged, onTimeChanged, controls());
  buildLegend(legendEl, appliedRequest?.filters ?? draftFilters, resultUsers);
}
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
function showStatus(text: string, warning = false) {
  status = text;
  renderStatus();
  statusEl.style.color = warning ? '#ff8a80' : 'var(--muted)';
  rebuild();
}

function markDirty() {
  scan.markDirty();
  dirty = scan.dirty;
  if (!loading) showStatus(t('status.dirty'));
  else rebuild();
}

// Фільтри за подією (Y, відкат) можна змінювати локально, лише якщо всі плитки вже мають
// точні події (немає агрегатів без деталізації) і сервер не відсікав їх цим самим фільтром.
function allEventsLoaded(request: AppliedRequest) {
  if (request.aggregateTileTotal == null) return true;
  return !!detailSession && detailSession.loadedCount >= request.aggregateTileTotal;
}
function canLiveY() {
  const request = appliedRequest;
  return !!request && request.filters.y == null && allEventsLoaded(request);
}
function canLiveRolledBack() {
  const request = appliedRequest;
  return !!request && request.filters.rolledBack == null && allEventsLoaded(request);
}

// Режим забарвлення, домішування й (за можливості) Y та відкат лише перемальовують завантажені дані.
// Пауза дає користувачеві завершити введення, перш ніж перемальовувати карту.
const VIEW_APPLY_DELAY_MS = 250;
let viewTimer: number | null = null;
// Фільтри, застосовані локально до завантажених даних.
let shownLive: EventViewFilter = { ...NO_EVENT_VIEW_FILTER };
function scheduleViewApply() {
  if (viewTimer != null) window.clearTimeout(viewTimer);
  viewTimer = window.setTimeout(applyView, VIEW_APPLY_DELAY_MS);
}
function applyView() {
  viewTimer = null;
  const request = appliedRequest;
  if (!request) {
    buildLegend(legendEl, draftFilters, resultUsers);
    return;
  }
  // Деталізація, що ще надходить, малюється за знімком запиту, тож оновлюємо й його.
  request.filters.mode = draftFilters.mode;
  request.filters.mix = draftFilters.mix;
  const liveY = canLiveY(),
    liveRolledBack = canLiveRolledBack();
  const live: Partial<EventViewFilter> = {};
  if (liveY) live.y = draftFilters.y;
  if (liveRolledBack) live.rolledBack = draftFilters.rolledBack;
  map.restyle(colorContext(request.filters), live);
  shownLive = { ...shownLive, ...live };
  buildLegend(legendEl, request.filters, resultUsers);
  // Фільтр змінився, але даних для локального застосування немає: потрібне «Оновити дані».
  const yPending = !liveY && !sameYRange(draftFilters.y, shownLive.y ?? request.filters.y);
  const rolledBackPending =
    !liveRolledBack && draftFilters.rolledBack !== (shownLive.rolledBack ?? request.filters.rolledBack);
  if (yPending || rolledBackPending) markDirty();
}

function onFiltersChanged(patch: Partial<Filters>) {
  Object.assign(draftFilters, patch);
  if (patch.world && bluemap) {
    bluemap.setWorld(draftFilters.world);
    onCamera(map.cam.scale, map.cam.cx, map.cam.cz); // шар очищено, тож одразу вантажимо тайли нового світу
    updateHud();
  }
  const keys = Object.keys(patch) as (keyof Filters)[];
  const viewOnly =
    keys.length > 0 &&
    keys.every(
      (key) =>
        key === 'mode' || key === 'mix' || (key === 'y' && canLiveY()) || (key === 'rolledBack' && canLiveRolledBack()),
    );
  if (viewOnly) {
    scheduleViewApply();
    return;
  }
  markDirty();
}
function onTimeChanged(time: TimeSelection, preserveEditor = false) {
  draftTime = time;
  rangeError = null;
  if (!preserveEditor) {
    markDirty();
    return;
  }
  scan.markDirty();
  dirty = scan.dirty;
  if (!loading) {
    status = t('status.dirty');
    statusEl.style.color = 'var(--muted)';
  }
  renderStatus();
}
function updateHud() {
  const coordinates =
    cursorX == null || cursorZ == null ? 'X: — Z: —' : `X: ${Math.floor(cursorX)} Z: ${Math.floor(cursorZ)}`;
  const displayedWorld = appliedRequest?.filters.world;
  const differentDisplayedWorld =
    displayedWorld && displayedWorld !== draftFilters.world ? t('status.displayedData', { world: displayedWorld }) : '';
  const scale = (1 / map.cam.scale).toFixed(1);

  hudEl.textContent = [
    t('status.world', { world: draftFilters.world, displayed: differentDisplayedWorld }),
    coordinates,
    t('status.scale', { scale }),
  ].join(' · ');
}
function onCamera(scale: number, cx: number, cz: number) {
  updateHud();
  if (!bluemap) return;

  const w = map.app.renderer.width / scale;
  const h = map.app.renderer.height / scale;
  bluemap.update({
    x1: cx - w / 2,
    z1: cz - h / 2,
    x2: cx + w / 2,
    z2: cz + h / 2,
    pxPerBlock: scale,
  });
}
function onCursorMove(x: number, z: number) {
  cursorX = Number.isFinite(x) ? x : null;
  cursorZ = Number.isFinite(z) ? z : null;
  updateHud();
}
// Detail tiles may arrive after a draft edit, so raster colors use the applied snapshot.
function colorContext(filters: Filters = draftFilters) {
  return {
    mode: filters.mode,
    mix: filters.mix,
    tMin: 0,
    tMax: 1,
  };
}

function abortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

// Load every paginated event result for a query that fits the detail limit.
async function fetchAll(request: AppliedRequest) {
  const all: CpEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await apiQueryPage(
      request.filters,
      { snapshot: request.snapshot, cursor, pageSize: request.config.coreProtectTiles.detailPageSize },
      controller!.signal,
    );
    if (!isCurrent(request)) return [];
    all.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return dedupeEvents(all);
}

// Load and install the exact events for one aggregate tile.
async function loadDetailTile(request: AppliedRequest, key: string) {
  const [tx, tz] = key.split(':').map(Number);
  const b = tileBounds({ x: tx, z: tz }, request.config.coreProtectTiles.tileSize);
  const events: CpEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await apiQueryPage(
      request.filters,
      {
        snapshot: request.snapshot,
        cursor,
        pageSize: request.config.coreProtectTiles.detailPageSize,
        tile: { xMin: b.x1, xMaxExclusive: b.x2, zMin: b.z1, zMaxExclusive: b.z2 },
      },
      controller!.signal,
    );
    if (!isCurrent(request)) return false;
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);

  return (
    isCurrent(request) &&
    map.installEventTile(request.generation, key, dedupeEvents(events), colorContext(request.filters))
  );
}
function detailProgress(request: AppliedRequest) {
  return t('status.detailProgress', {
    loaded: detailSession?.loadedCount ?? 0,
    total: request.aggregateTileTotal ?? 0,
    events: aggregateTotal(request),
  });
}
function startMassDetails() {
  const session = detailSession,
    request = appliedRequest;
  if (!session || !request || !isCurrent(request) || detailRun) return;
  if (!session.startMass()) return;

  const total = request.aggregateTileTotal ?? session.queue.size;
  let partial = 0;
  setLoading(true);
  showStatus(t('status.detailLoading'));

  const run: Promise<void> = (async () => {
    // Parallel workers drain the queue until it is empty, stopped, or obsolete.
    const worker = async () => {
      while (isCurrent(request) && !session.isStopped) {
        const key = session.takeMass();
        if (!key) return;

        let installed = false;
        try {
          installed = await loadDetailTile(request, key);
        } catch (error) {
          if (!abortError(error)) partial++;
        } finally {
          session.queue.complete(key, installed);
          if (isCurrent(request) && !session.isStopped) {
            showStatus(
              t('status.detailing', {
                partial: partial ? t('status.partialErrorsPrefix') : '',
                progress: detailProgress(request),
              }),
            );
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(session.workerCap, total) }, worker));
    if (isCurrent(request) && !session.isStopped) {
      showStatus(
        t('status.detailDone', {
          partial: partial ? t('status.partialErrorsDone') : '',
          progress: detailProgress(request),
        }),
        partial > 0,
      );
    }
  })().finally(() => {
    if (detailRun === run) detailRun = null;
    if (isCurrent(request)) {
      setLoading(false);
      rebuild();
    }
  });
  detailRun = run;
}

function startSingleDetail(key: string) {
  const session = detailSession,
    request = appliedRequest;
  if (!session || !request || !isCurrent(request)) return;
  const action = session.startSingle(key);
  if (action === 'prioritized') {
    showStatus(t('status.areaQueued'));
    return;
  }
  if (action !== 'started') return;
  setLoading(true);
  showStatus(t('status.areaLoading'));

  const run: Promise<void> = (async () => {
    let installed = false;
    try {
      installed = await loadDetailTile(request, key);
    } catch (error) {
      if (!abortError(error) && isCurrent(request)) {
        showStatus(t('status.areaError', { error: String(error) }), true);
      }
    } finally {
      session.queue.complete(key, installed);
      if (isCurrent(request) && !session.isStopped && installed) {
        showStatus(t('status.areaLoaded', { progress: detailProgress(request) }));
      }
    }
  })().finally(() => {
    detailSingleRuns.delete(run);
    if (isCurrent(request) && !detailRun && detailSingleRuns.size === 0) {
      setLoading(false);
      rebuild();
    }
  });
  detailSingleRuns.add(run);
}
function aggregateTotal(request: AppliedRequest) {
  return request.aggregateTotal ?? 0;
}
function uniqueEventUsers(events: CpEvent[]) {
  // UUID є стабільним ключем; для старих записів без UUID використовується нік.
  const users = new Map<string, { nick: string | null; uuid: string | null }>();
  for (const event of events) {
    const key = event.uuid ? `uuid:${event.uuid}` : `nick:${event.nick ?? ''}`;
    if (!users.has(key)) users.set(key, { nick: event.nick, uuid: event.uuid });
  }
  return [...users.values()].sort((left, right) => (left.nick ?? '').localeCompare(right.nick ?? '', 'uk'));
}
async function apply() {
  const effective = calculateEffectiveTime(draftTime, Math.floor(Date.now() / 1000));
  if (effective.error) {
    rangeError = effective.error;
    rebuild();
    return;
  }

  // Cancel the old request before creating a fresh data generation.
  rangeError = null;
  detailSession?.stop();
  detailSession = null;
  detailRun = null;
  detailSingleRuns.clear();
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const filters = cloneFilters(draftFilters);
  filters.tFrom = effective.from;
  filters.tTo = effective.to;
  const localGeneration = scan.start();
  generation = localGeneration;
  shownLive = { ...NO_EVENT_VIEW_FILTER };
  setLoading(true);
  dirty = scan.dirty;
  showStatus(t('status.metadata'));

  try {
    meta = await apiRefreshMeta(signal);
    if (signal.aborted || localGeneration !== generation) return;

    showStatus(t('status.checkingVolume'));
    const plan = await apiQueryPlan(filters, undefined, signal);
    if (signal.aborted || localGeneration !== generation) return;

    const request: AppliedRequest = {
      filters,
      center: { x: map.cam.cx, z: map.cam.cz, scale: map.cam.scale },
      config,
      snapshot: plan.snapshot,
      generation: localGeneration,
    };
    appliedRequest = request;

    // Small queries are loaded as complete event tiles immediately.
    if (plan.strategy === 'all') {
      const events = await fetchAll(request);
      if (!isCurrent(request)) return;

      const groups = distributeEventsByTile(events, config.coreProtectTiles.tileSize);
      map.beginDataGeneration(localGeneration);
      for (const [key, tileEvents] of groups) {
        map.setEventTile(localGeneration, key, tileEvents, colorContext(request.filters));
      }
      if (!isCurrent(request) || !map.commitDataGeneration(localGeneration)) return;

      resultUsers = uniqueEventUsers(events);
      resultBounds =
        plan.bounds ??
        (events.length
          ? {
              x1: Math.min(...events.map((event) => event.x)),
              x2: Math.max(...events.map((event) => event.x)),
              z1: Math.min(...events.map((event) => event.z)),
              z2: Math.max(...events.map((event) => event.z)),
            }
          : null);
      showStatus(t('status.eventsLoaded', { count: plan.totalExact ? events.length : `>${plan.threshold}` }));
      return;
    }

    // Large queries first display the aggregate layer and prepare detail tiles.
    showStatus(t('status.buildingOverview'));
    const aggregate = await apiAggregate(filters, request.snapshot, config.coreProtectTiles.tileSize, signal);
    if (!isCurrent(request)) return;

    const grouped = new Map<string, typeof aggregate.chunks>();
    for (const chunk of aggregate.chunks) {
      const key = tileKey({
        x: Math.floor((chunk.cx * 16) / config.coreProtectTiles.tileSize),
        z: Math.floor((chunk.cz * 16) / config.coreProtectTiles.tileSize),
      });
      const group = grouped.get(key);
      if (group) group.push(chunk);
      else grouped.set(key, [chunk]);
    }

    map.beginDataGeneration(localGeneration);
    for (const [key, chunks] of grouped) {
      map.setAggregateTile(localGeneration, key, chunks, colorContext(request.filters));
    }
    if (!map.commitDataGeneration(localGeneration)) return;

    resultUsers = aggregate.players;
    resultBounds = aggregate.bbox;
    const occupied = aggregate.occupiedTiles.map((tile) => ({ x: tile.tx, z: tile.tz }));
    const priorityCenter = {
      x: Math.floor(request.center.x / config.coreProtectTiles.tileSize),
      z: Math.floor(request.center.z / config.coreProtectTiles.tileSize),
    };
    const detailKeys = sortOccupiedTiles(occupied, priorityCenter).map(tileKey);
    const queue = new DetailTileQueue(detailKeys);
    request.aggregateTotal = aggregate.total;
    request.aggregateTileTotal = queue.size;
    detailSession = new DetailQueueSession(queue, config.coreProtectTiles.maxConcurrentRequests);
    detailPriority = startSingleDetail;
    setLoading(false);
    showStatus(t('status.overviewLoaded', { total: aggregate.total }));
    return;
  } catch (error) {
    if (!abortError(error) && !signal.aborted) {
      showStatus(t('status.errorKeptMap', { error: String(error) }), true);
    }
  } finally {
    if (localGeneration === generation && !detailRun) {
      setLoading(false);
      rebuild();
    }
  }
}

function stop() {
  detailSession?.stop();
  detailPriority = null;
  scan.stop(generation);
  controller?.abort();
  setLoading(false);
  showStatus(t('status.stopped'));
}
// Coordinates from Pixi are viewport-relative, while the tooltip is positioned inside #map-wrap.
function onHover(events: CpEvent[] | null, sx: number, sy: number) {
  if (!events?.length) {
    tooltipEl.style.display = 'none';
    return;
  }

  const context = colorContext(appliedRequest?.filters ?? draftFilters);
  const visibleEvents = events.slice(0, 6);
  const fragment = document.createDocumentFragment();
  for (const event of visibleEvents) {
    const item = inspectorElement('div');
    item.className = 'ev';
    const swatch = inspectorElement('span');
    swatch.className = 'swatch';
    swatch.style.background = rgbHex(eventColor(event, context));
    const nick = inspectorElement('b', event.nick ?? '?');
    nick.className = 'nick';
    const details = inspectorElement(
      'span',
      ` · ${eventActionLabel(event)} · ${event.material ?? '—'} · ${localTime(event.time)}`,
    );
    details.className = 'tiny';
    item.append(swatch, nick, details);
    fragment.append(item);
  }
  if (events.length > visibleEvents.length) {
    const more = inspectorElement('div', t('inspector.more', { count: events.length - visibleEvents.length }));
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
function eventActionLabel(event: CpEvent) {
  return actionLabel(event.src, event.action);
}

function localTime(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toLocaleString(i18n.resolvedLanguage);
}

function closeInspector() {
  inspectorRequest++;
  inspectorEl.classList.remove('open');
  inspectorEl.replaceChildren();
}

function inspectorRow(label: string, value: string, small = false) {
  const row = inspectorElement('div');
  row.className = 'kv';
  const key = inspectorElement('span', label);
  key.className = 'k';
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
    button.textContent = t('inspector.copied');
  } catch {
    button.textContent = t('inspector.clipboardUnavailable');
    button.title = command;
  }
}
function sameEvent(left: CpEvent, right: CpEvent) {
  return left.src === right.src && left.rowid_src === right.rowid_src;
}
function eventListLabel(event: CpEvent) {
  return `${event.nick ?? '?'} · ${eventActionLabel(event)} · ${event.material ?? '—'} · ${localTime(event.time)}`;
}

// Render the selected event and all related events already loaded for its tile.
function renderInspector(event: CpEvent, nearby: CpEvent[], blockEvents: CpEvent[]) {
  inspectorEl.replaceChildren();
  const heading = inspectorElement('div');
  heading.className = 'row inspector-heading';
  const title = inspectorElement('h3', t('inspector.title'));
  title.className = 'inspector-title';
  const close = inspectorElement('button', '✕');
  close.type = 'button';
  close.title = t('inspector.close');
  close.addEventListener('click', closeInspector);
  heading.append(title, close);

  const card = inspectorElement('div');
  card.className = 'card';
  const player = inspectorElement('h4', event.nick ?? '?');
  card.append(
    player,
    inspectorRow(t('inspector.action'), eventActionLabel(event)),
    inspectorRow(t('inspector.block'), event.material ?? '—'),
  );
  if (event.amount != null) card.append(inspectorRow(t('inspector.amount'), String(event.amount)));
  card.append(
    inspectorRow(t('inspector.coordinates'), `${event.x} / ${event.y} / ${event.z}`),
    inspectorRow(t('inspector.world'), event.world),
    inspectorRow(t('inspector.time'), localTime(event.time)),
    inspectorRow(t('inspector.rolledBack'), event.rolled_back ? t('inspector.yes') : t('inspector.no')),
    inspectorRow('UUID', event.uuid ?? '—', true),
  );

  const actions = inspectorElement('div');
  actions.className = 'row inspector-actions';
  const filterPlayer = inspectorElement('button', t('inspector.filterPlayer'));
  filterPlayer.type = 'button';
  filterPlayer.addEventListener('click', () => {
    onFiltersChanged({ users: event.nick ? [event.nick] : [], usersExcl: false });
  });
  const copy = inspectorElement('button', t('inspector.copyTp'));
  copy.type = 'button';
  copy.addEventListener('click', () => void copyTeleport(copy, event));
  actions.append(filterPlayer, copy);

  // Усі події в точці вже завантажено разом із плиткою карти, тому їх
  // можна вибирати без повторного клацання перекритих маркерів.
  const blockHeading = inspectorElement(
    'h3',
    t('inspector.blockEvents', { x: event.x, z: event.z, count: blockEvents.length }),
  );
  const blockCard = inspectorElement('div');
  blockCard.className = 'card block-events';
  for (const blockEvent of [...blockEvents].sort(
    (left, right) => right.time - left.time || right.rowid_src - left.rowid_src,
  )) {
    const item = inspectorElement('button', eventListLabel(blockEvent));
    item.type = 'button';
    item.className = 'block-event-item';
    if (sameEvent(blockEvent, event)) {
      item.classList.add('active');
      item.setAttribute('aria-current', 'true');
    } else {
      item.addEventListener('click', () => void showInspectorEvent(blockEvent, blockEvents));
    }
    blockCard.append(item);
  }

  const nearbyHeading = inspectorElement('h3', t('inspector.nearby'));
  const nearbyCard = inspectorElement('div');
  nearbyCard.className = 'card nearby-events';
  if (!nearby.length) {
    const empty = inspectorElement('span', t('inspector.noData'));
    empty.className = 'tiny';
    nearbyCard.append(empty);
  } else {
    for (const nearbyEvent of nearby) {
      const item = inspectorElement('div');
      item.className = 'nearby-item';
      const actor = inspectorElement(
        'div',
        t('inspector.player', { nick: nearbyEvent.nick ?? t('inspector.unknownPlayer') }),
      );
      actor.className = 'nearby-actor';
      const nearbyDetails = [
        eventActionLabel(nearbyEvent),
        nearbyEvent.material ?? '—',
        `${nearbyEvent.x}, ${nearbyEvent.y}, ${nearbyEvent.z}`,
        new Date(nearbyEvent.time * 1000).toLocaleTimeString(i18n.resolvedLanguage),
      ].join(' · ');
      const details = inspectorElement('div', nearbyDetails);
      details.className = 'nearby-details';
      item.append(actor, details);
      nearbyCard.append(item);
    }
  }
  inspectorEl.append(heading, card, actions, blockHeading, blockCard, nearbyHeading, nearbyCard);
}
async function showInspectorEvent(event: CpEvent, blockEvents: CpEvent[]) {
  // The monotonically increasing token ignores stale asynchronous responses.
  const request = ++inspectorRequest;
  inspectorEl.classList.add('open');
  inspectorEl.replaceChildren();
  const loadingMessage = inspectorElement('div', t('inspector.loading'));
  loadingMessage.className = 'tiny';
  inspectorEl.append(loadingMessage);
  try {
    const detail = await apiEvent(event.src, event.rowid_src);
    if (request !== inspectorRequest) return;
    renderInspector(detail.event, detail.nearby, blockEvents);
  } catch {
    if (request !== inspectorRequest) return;
    inspectorEl.replaceChildren();
    const message = inspectorElement('div', t('inspector.loadFailed'));
    message.className = 'tiny';
    const close = inspectorElement('button', t('inspector.closeButton'));
    close.type = 'button';
    close.addEventListener('click', closeInspector);
    inspectorEl.append(message, close);
  }
}
async function onClick(events: CpEvent[]) {
  if (!events.length) {
    closeInspector();
    return;
  }
  // Події впорядковані від нових до старих, тому верхня подія є першою.
  await showInspectorEvent(events[0], events);
}

// Ініціалізує карту лише після успішної Discord-авторизації.
async function bootMap() {
  config = await apiConfig();
  draftFilters = defaultFilters(config.defaultLimit);
  meta = await apiMeta();

  if (!meta.worlds.some((world) => world.world === draftFilters.world)) {
    draftFilters.world = meta.worlds[0]?.world ?? draftFilters.world;
  }

  map = new MapView(
    $('map'),
    {
      onHover,
      onClick,
      onSelection: (bbox) => {
        draftFilters.bbox = bbox;
        markDirty();
      },
      onCameraChange: onCamera,
      onCursorMove,
      onPrioritizeTile: (key) => detailPriority?.(key),
    },
    config.coreProtectTiles,
  );
  await map.ready;
  map.setLodMarkersVisible(lodMarkersVisible);

  bluemap = new BluemapLayer(config.bluemap as never);
  map.world.addChildAt(bluemap.container, 0);
  bluemap.setOpacity(bluemapOpacity);
  bluemap.setWorld(draftFilters.world);
  // Над BlueMap, але під даними CoreProtect (вони додаються в world пізніше).
  xaero = new XaeroOverlayLayer();
  map.world.addChildAt(xaero.container, 1);
  xaero.setOpacity(bluemapOpacity);
  const overlay = config.mapOverlay;
  if (overlay?.enabled && overlay.url) {
    xaero.setPlacement({ x: overlay.x, z: overlay.z, pxPerBlock: overlay.pxPerBlock });
    fetch(overlay.url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => xaero.load(blob))
      .catch((err) => console.warn('Map overlay failed to load', err));
  }
  // Камера вже повідомила про свій стан до створення шару, тож без цього тайли
  // з'являються лише після першої зміни масштабу.
  onCamera(map.cam.scale, map.cam.cx, map.cam.cz);

  updateHud();
  rebuild();
  showStatus(t('status.initial'));

  window.addEventListener('keydown', (event) => {
    if (!event.repeat && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void apply();
    }
  });
}

async function renderBlacklist() {
  const container = $('blacklist-users');
  const result = await apiBlacklist();
  container.replaceChildren(
    ...result.users.map((user) => {
      const row = document.createElement('div');
      row.className = 'blacklist-row';
      const label = document.createElement('span');
      label.textContent = user.discordId;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = t('blacklist.remove');
      remove.addEventListener('click', async () => {
        await apiUnblockUser(user.discordId);
        await renderBlacklist();
      });
      row.append(label, remove);
      return row;
    }),
  );
  if (!result.users.length) container.textContent = t('blacklist.empty');
}

/** Налаштовує профіль та адміністративні дії. */
function setupAccount(user: AuthUser) {
  const renderAccountName = () => {
    $('account-name').textContent =
      `${user.username} · ${user.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleModerator')}`;
  };
  renderAccountName();
  const languageSelect = $('language-select') as HTMLSelectElement;
  languageSelect.value = i18n.resolvedLanguage ?? 'en';
  enhanceSelect(languageSelect);
  languageSelect.addEventListener('change', async () => {
    await i18n.changeLanguage(languageSelect.value);
    translateStatic();
    renderAccountName();
    if (map) {
      closeInspector();
      updateHud();
      if (!appliedRequest && !dirty) status = t('status.initial');
      showStatus(status);
    }
    if ($('admin-dialog').hasAttribute('open')) await renderBlacklist();
  });
  $('logout-button').addEventListener('click', async () => {
    await apiLogout();
    location.reload();
  });
  if (user.role !== 'admin') return;
  const adminButton = $('admin-button') as HTMLButtonElement;
  const dialog = $('admin-dialog') as HTMLDialogElement;
  adminButton.hidden = false;
  adminButton.addEventListener('click', async () => {
    dialog.showModal();
    await renderBlacklist();
  });
  $('blacklist-add').addEventListener('click', async () => {
    const input = $('blacklist-id') as HTMLInputElement;
    const error = $('blacklist-error');
    try {
      await apiBlockUser(input.value.trim());
      input.value = '';
      error.textContent = '';
      await renderBlacklist();
    } catch (cause) {
      error.textContent = t('blacklist.addFailed', { error: String(cause) });
    }
  });
}

/** Перекладає статичну розмітку з index.html (data-i18n, data-i18n-attr="атрибут:ключ"). */
function translateStatic() {
  document.documentElement.lang = i18n.resolvedLanguage ?? 'en';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n!);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((element) => {
    const [attribute, key] = element.dataset.i18nAttr!.split(':');
    element.setAttribute(attribute, t(key));
  });
}

/** Перевіряє сесію перед завантаженням захищених даних. */
async function boot() {
  translateStatic();
  const user = await apiAuthMe();
  if (!user) {
    if (new URLSearchParams(location.search).get('auth') === 'denied') $('auth-message').textContent = t('auth.denied');
    return;
  }
  $('auth-screen').hidden = true;
  $('app').hidden = false;
  setupAccount(user);
  await bootMap();
}

void boot().catch((error) => {
  $('auth-message').textContent = t('auth.error', { error: String(error) });
});
