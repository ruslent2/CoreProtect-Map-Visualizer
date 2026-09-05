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
  const overview = map.cam.scale <= 3; // LOD: далеко — агрегаты по чанкам
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
  } catch { /* конфиг недоступен — без подложки */ }
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
