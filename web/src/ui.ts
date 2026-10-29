import { t } from './i18n';
import { enhanceSelect } from './dropdown';
import type { Filters, TimeSelection } from './state';
import { epochSecondsToLocalDateTime, formatYRange, localDateTimeToEpochSeconds, parseYRange, presetTimeSelection } from './state';
import type { ColorMode } from './colors';
import { uuidColor, actionColor, rgbHex, ACTION_CODES, actionLabel } from './colors';

type ChangeFn = (patch: Partial<Filters>) => void;
type TimeChangeFn = (time: TimeSelection, preserveEditor?: boolean) => void;
export interface ScanControls {
  status: string;
  error?: string | null;
  canShowAll: boolean;
  canStop: boolean;
  canContinueDetails: boolean;
  /** Дані завантажено по всій висоті, тож Y можна змінювати без нового запиту. */
  canLiveY: boolean;
  bluemapOpacity: number;
  lodMarkersVisible: boolean;
  onBluemapOpacity(alpha: number): void;
  onLodMarkersVisible(enabled: boolean): void;
  onApply(): void;
  onStop(): void;
  onContinueDetails(): void;
  onShowAll(): void;
}

export interface MetaData {
  worlds: { id: number; world: string }[];
  users: { id: number; nick: string; uuid: string | null }[];
  materials: string[];
  actions: { id: string; label: string; src: string; action: number }[];
}

const MODE_KEYS: ColorMode[] = ['user', 'action', 'material', 'time'];
const modeLabel = (mode: ColorMode) => t(`modes.${mode}`);

function globSuggestionMatches(name: string, pattern: string, caseSensitive: boolean) {
  // Без glob-символів пропонуємо імена за префіксом. За наявності * або ?
  // перевіряємо весь введений шаблон так само, як сервер.
  const hasGlob = pattern.includes('*') || pattern.includes('?');
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[\\^$+.()|{}[\]]/g, '\\$&');
  }
  if (!hasGlob) source += '.*';
  try {
    return new RegExp(`^${source}$`, caseSensitive ? '' : 'i').test(name);
  } catch {
    return false;
  }
}

function splitPatternPrefix(line: string) {
  const prefix = line.match(/^(?:!|\(\?i\))*/)?.[0] ?? '';
  return { prefix, pattern: line.slice(prefix.length), caseSensitive: prefix.includes('(?i)') };
}

// Заголовок секції з іконкою «?»: підказка з'являється при наведенні або фокусі.
function helpHeading(title: string, help: string, helpTitle?: string) {
  const h = document.createElement('h3');
  h.className = 'pattern-heading';
  h.append(title);
  const tip = document.createElement('span');
  tip.className = 'help-tip';
  tip.tabIndex = 0;
  tip.textContent = '?';
  const popup = document.createElement('span');
  popup.className = 'help-tip-popup';
  if (helpTitle) {
    const heading = document.createElement('strong');
    heading.textContent = helpTitle;
    popup.append(heading, document.createElement('br'));
  }
  popup.append(help);
  tip.append(popup);
  h.append(tip);
  return h;
}

const patternHeading = (title: string) => helpHeading(title, t('filters.patternHelp'), t('filters.patternHelpTitle'));

// Секції за порядком заголовків h3 у панелі. Стан згортання зберігаємо в localStorage:
// панель перебудовується після кожної зміни фільтра, тож DOM його не пам'ятає.
const SECTION_IDS = ['world', 'colorMode', 'bluemap', 'time', 'yLevel', 'players', 'materials', 'actions', 'area'];
const SECTIONS_OPEN_DEFAULT = new Set(['colorMode', 'time', 'players', 'actions']);
const SECTIONS_STORAGE_KEY = 'filterSectionsOpen';

function loadSectionState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function saveSectionState(id: string, open: boolean) {
  try {
    localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify({ ...loadSectionState(), [id]: open }));
  } catch { /* localStorage може бути недоступним: тоді стан діє до перебудови панелі */ }
}

// Загортає кожен h3 разом з елементами до наступного h3 у згортну секцію.
function groupSections(root: HTMLElement) {
  const state = loadSectionState();
  const sections: HTMLDetailsElement[] = [];
  let body: HTMLElement | null = null;
  for (const node of Array.from(root.children)) {
    if (node.tagName === 'H3') {
      const id = SECTION_IDS[sections.length] ?? `section${sections.length}`;
      const details = document.createElement('details');
      details.className = 'filter-section';
      details.open = state[id] ?? SECTIONS_OPEN_DEFAULT.has(id);
      details.addEventListener('toggle', () => saveSectionState(id, details.open));
      const summary = document.createElement('summary');
      // Клік по іконці підказки не має згортати секцію.
      summary.addEventListener('click', event => { if ((event.target as HTMLElement).closest('.help-tip')) event.preventDefault(); });
      summary.append(node);
      body = document.createElement('div');
      body.className = 'filter-section-body';
      details.append(summary, body);
      sections.push(details);
    } else {
      body?.append(node);
    }
  }
  root.replaceChildren(...sections);
}

export function buildFilterPanel(
  root: HTMLElement, f: Filters, time: TimeSelection, meta: MetaData, onChange: ChangeFn, onTimeChange: TimeChangeFn, controls: ScanControls
) {
  root.innerHTML = '';
  const el = (html: string) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild as HTMLElement;
  };

  // --- Світ і режим ---
  root.append(el(`<h3>${t('filters.world')}</h3>`));
  const worldSel = el(`<select>${meta.worlds.map(w =>
    `<option value="${w.world}" ${w.world === f.world ? 'selected' : ''}>${w.world}</option>`).join('')}</select>`) as HTMLSelectElement;
  worldSel.onchange = () => onChange({ world: worldSel.value });
  root.append(enhanceSelect(worldSel));

  root.append(el(`<h3>${t('filters.colorMode')}</h3>`));
  const modeSel = el(`<select>${MODE_KEYS.map(m =>
    `<option value="${m}" ${m === f.mode ? 'selected' : ''}>${modeLabel(m)}</option>`).join('')}</select>`) as HTMLSelectElement;
  modeSel.onchange = () => onChange({ mode: modeSel.value as ColorMode });
  root.append(enhanceSelect(modeSel));

  const mixRow = el(`<div class="row"><span class="tiny">${t('filters.mix')}</span><input id="mix" type="range" min="0" max="50" value="${Math.round(f.mix * 100)}"><span class="tiny" id="mixv">${Math.round(f.mix * 100)}%</span></div>`);
  mixRow.querySelector<HTMLInputElement>('#mix')!.oninput = e => {
    const v = +(e.target as HTMLInputElement).value;
    mixRow.querySelector('#mixv')!.textContent = v + '%';
    onChange({ mix: v / 100 });
  };
  root.append(mixRow);

  // Локальне налаштування підкладки: не змінює фільтр і не запускає запити.
  root.append(el(`<h3>${t('filters.bluemap')}</h3>`));
  const opacityRow = el(`<div class="row opacity-control"><span class="tiny">${t('filters.opacity')}</span><input id="bluemap-opacity" type="range" min="0" max="100" value="${Math.round(controls.bluemapOpacity * 100)}"><span class="tiny" id="bluemap-opacity-value">${Math.round(controls.bluemapOpacity * 100)}%</span></div>`);
  opacityRow.querySelector<HTMLInputElement>('#bluemap-opacity')!.oninput = event => {
    const value = Number((event.target as HTMLInputElement).value) / 100;
    opacityRow.querySelector('#bluemap-opacity-value')!.textContent = `${Math.round(value * 100)}%`;
    controls.onBluemapOpacity(value);
  };
  root.append(opacityRow);
  const lodMarkersRow = el(`<label class="row lod-markers-control"><input id="lod-markers-visible" type="checkbox" ${controls.lodMarkersVisible ? 'checked' : ''}><span class="tiny">${t('filters.lodMarkers')}</span></label>`);
  lodMarkersRow.querySelector<HTMLInputElement>('#lod-markers-visible')!.onchange = event => {
    controls.onLodMarkersVisible((event.target as HTMLInputElement).checked);
  };
  root.append(lodMarkersRow);

  // --- Час ---
  root.append(el(`<h3>${t('filters.time')}</h3>`));
  const isPreset = (hours: number) => time.mode === 'range' && time.from != null && time.to != null && time.to - time.from === hours * 3600;
  const timeRow = el(`<div class="row">
    <button class="t-preset ${isPreset(6) ? 'active' : ''}" data-h="6">${t('filters.hours6')}</button>
    <button class="t-preset ${isPreset(24) ? 'active' : ''}" data-h="24">${t('filters.hours24')}</button>
    <button class="t-preset ${isPreset(168) ? 'active' : ''}" data-h="168">${t('filters.days7')}</button>
    <button class="t-preset ${isPreset(720) ? 'active' : ''}" data-h="720">${t('filters.days30')}</button>
    <button id="t-clear" class="excl-toggle ${time.mode === 'all' ? 'on' : ''}">${t('filters.allTime')}</button>
  </div>`);
  timeRow.querySelectorAll<HTMLButtonElement>('.t-preset').forEach(b => {
    b.onclick = () => onTimeChange(presetTimeSelection((Number(b.dataset.h) === 6 ? 'last6Hours' : Number(b.dataset.h) === 24 ? 'last24Hours' : Number(b.dataset.h) === 168 ? 'last7Days' : 'last30Days'), Math.floor(Date.now() / 1000)));
  });
  (timeRow.querySelector('#t-clear') as HTMLButtonElement).onclick = () => onTimeChange({ mode: 'all', from: null, to: null });
  root.append(timeRow);
  const timeInputs = el(`<div class="time-inputs"><input id="time-from" data-preserve-on-rebuild type="datetime-local" step="1" value="${epochSecondsToLocalDateTime(time.from) ?? ''}"><input id="time-to" data-preserve-on-rebuild type="datetime-local" step="1" value="${epochSecondsToLocalDateTime(time.to) ?? ''}"></div>`);
  // Під час редагування оновлюємо лише чернетку: перебудова DOM скидає активний
  // сегмент нативного datetime-local і заважає вводити значення клавіатурою.
  const updateTime = () => { const from = localDateTimeToEpochSeconds((timeInputs.querySelector('#time-from') as HTMLInputElement).value || null), to = localDateTimeToEpochSeconds((timeInputs.querySelector('#time-to') as HTMLInputElement).value || null); onTimeChange({ mode: 'range', from, to }, true); };
  timeInputs.querySelectorAll('input').forEach(input => input.addEventListener('input', updateTime));
  root.append(timeInputs);
  if (controls.error) root.append(el(`<div class="time-error">${controls.error}</div>`));

  // --- Рівень Y ---
  root.append(helpHeading(t('filters.yLevel'), t('filters.yLevelHelp')));
  const yInput = el(`<input type="text" autocomplete="off" spellcheck="false" placeholder="${t('filters.yPlaceholder')}">`) as HTMLInputElement;
  yInput.value = formatYRange(f.y);
  // Некоректний запис не застосовується; поле підсвічується, доки його не виправлять.
  const commitY = () => {
    const range = parseYRange(yInput.value);
    yInput.classList.toggle('invalid', range === undefined);
    if (range !== undefined) onChange({ y: range });
  };
  yInput.onchange = commitY;
  // Рівень Y застосовується на ходу лише коли дані завантажено по всій висоті; інакше
  // оновлення панелі під час введення забрало б фокус, тож чекаємо завершення вводу.
  yInput.oninput = () => { if (controls.canLiveY) commitY(); };
  root.append(yInput);

  // --- Гравці ---
  root.append(patternHeading(t('filters.players')));
  const userPatterns = document.createElement('textarea');
  userPatterns.className = 'pattern-input';
  userPatterns.rows = 5;
  userPatterns.placeholder = t('filters.patternPlaceholder');
  userPatterns.value = f.users.join('\n');
  const userPatternWrap = document.createElement('div');
  userPatternWrap.className = 'pattern-autocomplete';
  const suggestions = document.createElement('div');
  suggestions.className = 'pattern-suggestions';
  suggestions.hidden = true;
  userPatternWrap.append(userPatterns, suggestions);
  const commitUserPatterns = () => onChange({
    users: userPatterns.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
  });
  const hideSuggestions = () => { suggestions.hidden = true; suggestions.innerHTML = ''; };
  const chooseSuggestion = (nick: string) => {
    const lines = userPatterns.value.split(/\r?\n/);
    const line = lines[lines.length - 1];
    const { prefix } = splitPatternPrefix(line);
    lines[lines.length - 1] = prefix + nick;
    userPatterns.value = lines.join('\n');
    hideSuggestions();
    userPatterns.focus();
    commitUserPatterns();
  };
  const updateSuggestions = () => {
    const line = userPatterns.value.split(/\r?\n/).pop() ?? '';
    const { prefix, pattern, caseSensitive } = splitPatternPrefix(line);
    if (!pattern || !meta.users.length) { hideSuggestions(); return; }
    const matches = meta.users
      .map(u => u.nick)
      .filter((nick): nick is string => Boolean(nick))
      .filter(nick => globSuggestionMatches(nick, pattern, caseSensitive))
      .slice(0, 12);
    suggestions.innerHTML = '';
    for (const nick of matches) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pattern-suggestion';
      item.textContent = prefix + nick;
      item.onmousedown = event => { event.preventDefault(); chooseSuggestion(nick); };
      suggestions.append(item);
    }
    suggestions.hidden = matches.length === 0;
  };
  // Не перебудовуємо панель після кожного символу: це позбавляє textarea фокуса й
  // унеможливлює Enter. Правила застосовуються після завершення введення.
  userPatterns.onchange = commitUserPatterns;
  userPatterns.oninput = updateSuggestions;
  userPatterns.onfocus = updateSuggestions;
  userPatterns.onblur = () => { commitUserPatterns(); window.setTimeout(hideSuggestions, 150); };
  root.append(userPatternWrap);

  // --- Матеріали ---
  root.append(patternHeading(t('filters.materials')));
  const materialPatterns = document.createElement('textarea');
  materialPatterns.className = 'pattern-input';
  materialPatterns.rows = 5;
  materialPatterns.placeholder = t('filters.patternPlaceholder');
  materialPatterns.value = f.materials.join('\n');
  const materialPatternWrap = document.createElement('div');
  materialPatternWrap.className = 'pattern-autocomplete';
  const materialSuggestions = document.createElement('div');
  materialSuggestions.className = 'pattern-suggestions';
  materialSuggestions.hidden = true;
  materialPatternWrap.append(materialPatterns, materialSuggestions);
  const commitMaterialPatterns = () => onChange({
    materials: materialPatterns.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
  });
  const updateMaterialSuggestions = () => {
    const line = materialPatterns.value.split(/\r?\n/).pop() ?? '';
    const { prefix, pattern, caseSensitive } = splitPatternPrefix(line);
    const matches = pattern
      ? meta.materials.filter(m => globSuggestionMatches(m, pattern, caseSensitive)).slice(0, 12)
      : [];
    materialSuggestions.innerHTML = '';
    for (const material of matches) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pattern-suggestion';
      item.textContent = prefix + material;
      item.onmousedown = event => {
        event.preventDefault();
        const lines = materialPatterns.value.split(/\r?\n/);
        lines[lines.length - 1] = prefix + material;
        materialPatterns.value = lines.join('\n');
        materialSuggestions.hidden = true;
        materialPatterns.focus();
        commitMaterialPatterns();
      };
      materialSuggestions.append(item);
    }
    materialSuggestions.hidden = matches.length === 0;
  };
  materialPatterns.oninput = updateMaterialSuggestions;
  materialPatterns.onfocus = updateMaterialSuggestions;
  materialPatterns.onchange = commitMaterialPatterns;
  materialPatterns.onblur = () => {
    commitMaterialPatterns();
    window.setTimeout(() => { materialSuggestions.hidden = true; }, 150);
  };
  root.append(materialPatternWrap);

  // --- Дії ---
  root.append(el(`<h3>${t('filters.actions')}</h3>`));
  // Сервер передає точну пару джерело/код, тому колір відповідає вибраній дії.
  const actionItems = meta.actions.map(a => ({
    key: a.id,
    label: actionLabel(a.src, a.action),
    color: rgbHex(actionColor(a.src, a.action)),
  }));
  const actExcl = makeExclToggle('actionsExcl', f, onChange, t('filters.excludeSelected'));
  root.append(makeCheckboxPicker(actionItems, f.actions, v => onChange({ actions: v }), actExcl));

  // --- Ділянка ---
  root.append(el(`<h3>${t('filters.area')}</h3>`));
  const bboxRow = el(`<div class="row"><span class="tiny" id="bbox-info">${f.bbox ? bboxText(f.bbox) : t('filters.areaNotSet')}</span><button id="bbox-clear">${t('filters.areaClear')}</button></div>`);
  (bboxRow.querySelector('#bbox-clear') as HTMLButtonElement).onclick = () => onChange({ bbox: null });
  root.append(bboxRow);

  groupSections(root);

  // Чипи йдуть перед кнопками: кнопки закріплені внизу панелі (sticky) і мають бути останніми.
  renderChips(root, f, onChange);

  const scanRow = el(`<div class="scan-controls"><div class="row"><button class="primary" id="refresh">${t('buttons.refresh')}</button>${controls.canShowAll ? `<button id="show-all">${t('buttons.showAll')}</button>` : ''}${controls.canContinueDetails ? `<button id="continue-details">${t('buttons.continueDetails')}</button>` : ''}${controls.canStop ? `<button id="stop">${t('buttons.stop')}</button>` : ''}</div></div>`);
  (scanRow.querySelector('#refresh') as HTMLButtonElement).onclick = controls.onApply;
  (scanRow.querySelector('#show-all') as HTMLButtonElement | null)?.addEventListener('click', controls.onShowAll);
  (scanRow.querySelector('#continue-details') as HTMLButtonElement | null)?.addEventListener('click', controls.onContinueDetails);
  (scanRow.querySelector('#stop') as HTMLButtonElement | null)?.addEventListener('click', controls.onStop);
  root.append(scanRow);
}

function bboxText(b: NonNullable<Filters['bbox']>) {
  return `${Math.round(b.x1)},${Math.round(b.z1)} — ${Math.round(b.x2)},${Math.round(b.z2)}`;
}

function makeExclToggle(key: 'usersExcl' | 'actionsExcl' | 'materialsExcl', f: Filters, onChange: ChangeFn, label: string) {
  const b = document.createElement('button');
  b.className = 'excl-toggle' + (f[key] ? ' on' : '');
  b.textContent = (f[key] ? '☑ ' : '☐ ') + label;
  b.onclick = () => onChange({ [key]: !f[key] } as Partial<Filters>);
  return b;
}

interface PickItem { key: string; label: string; color?: string }

function makeMultiPicker(items: PickItem[], selected: string[], onSel: (v: string[]) => void) {
  const wrap = document.createElement('div');
  const search = document.createElement('input');
  search.type = 'text'; search.placeholder = t('filters.search');
  const list = document.createElement('div');
  list.className = 'list-picker';
  const render = (q: string) => {
    list.innerHTML = '';
    const flt = items.filter(i => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
    for (const it of flt) {
      const d = document.createElement('div');
      d.className = 'item' + (selected.includes(it.key) ? ' sel' : '');
      if (it.color) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = it.color;
        d.append(dot);
      }
      const label = document.createElement('span');
      label.textContent = it.label;
      d.append(label);
      d.onclick = () => {
        const v = selected.includes(it.key) ? selected.filter(s => s !== it.key) : [...selected, it.key];
        selected = v;
        onSel(v);
        d.classList.toggle('sel');
      };
      list.append(d);
    }
  };
  search.oninput = () => render(search.value);
  render('');
  wrap.append(search, list);
  return wrap;
}

function makeCheckboxPicker(items: PickItem[], selected: string[], onSel: (v: string[]) => void, headerExtra?: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.className = 'checkbox-picker';

  const allLabel = document.createElement('label');
  allLabel.className = 'checkbox-item checkbox-all';
  const all = document.createElement('input');
  all.type = 'checkbox';
  all.checked = items.length > 0 && items.every(item => selected.includes(item.key));
  all.indeterminate = selected.length > 0 && !all.checked;
  all.onchange = () => onSel(all.checked ? items.map(item => item.key) : []);
  allLabel.append(all, document.createTextNode(t('actions.all')));
  const allRow = document.createElement('div');
  allRow.className = 'checkbox-all-row';
  allRow.append(allLabel);
  if (headerExtra) allRow.append(headerExtra);
  wrap.append(allRow);

  const list = document.createElement('div');
  list.className = 'checkbox-list';
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'checkbox-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.includes(item.key);
    checkbox.onchange = () => onSel(
      checkbox.checked
        ? [...selected, item.key]
        : selected.filter(value => value !== item.key),
    );
    label.append(checkbox);
    if (item.color) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = item.color;
      label.append(dot);
    }
    label.append(document.createTextNode(item.label));
    list.append(label);
  }
  wrap.append(list);
  return wrap;
}

function renderChips(root: HTMLElement, f: Filters, onChange: ChangeFn) {
  const chips = document.createElement('div');
  chips.className = 'chips';
  const mk = (listKey: 'users' | 'actions' | 'materials') => {
    for (const v of f[listKey]) {
      const c = document.createElement('span');
      c.className = 'chip';
      const value = document.createElement('span');
      value.textContent = v;
      const close = document.createElement('span');
      close.className = 'x';
      close.textContent = '✕';
      close.addEventListener('click', () => onChange({ [listKey]: f[listKey].filter(x => x !== v) } as Partial<Filters>));
      c.append(value, close);
      chips.append(c);
    }
  };
  mk('users'); mk('actions'); mk('materials');
  if (f.tFrom || f.tTo) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `<span>${t('filters.timeChip')}</span><span class="x">✕</span>`;
    c.querySelector('.x')!.addEventListener('click', () => onChange({ tFrom: null, tTo: null }));
    chips.append(c);
  }
  root.append(chips);
}

export interface LegendUser { nick: string | null; uuid: string | null }

export function buildLegend(root: HTMLElement, f: Filters, users: LegendUser[] | null) {
  // Легенда з'являється лише для фактично відображеного результату пошуку.
  root.hidden = users === null;
  if (users === null) { root.replaceChildren(); return; }
  const note = (text: string, marginBottom = false) => {
    const element = document.createElement('div');
    element.className = 'tiny';
    if (marginBottom) element.style.marginBottom = '4px';
    element.textContent = text;
    root.append(element);
  };
  root.replaceChildren();
  // Клік по заголовку згортає легенду до одного рядка; стан зберігається між перебудовами.
  const collapsed = loadLegendCollapsed();
  const header = document.createElement('div');
  header.className = 'legend-header tiny' + (collapsed ? ' collapsed' : '');
  header.setAttribute('role', 'button');
  header.tabIndex = 0;
  header.setAttribute('aria-expanded', String(!collapsed));
  header.title = t(collapsed ? 'legend.expand' : 'legend.collapse');
  header.textContent = t('legend.mainColor', { mode: modeLabel(f.mode) });
  const toggle = () => { saveLegendCollapsed(!collapsed); buildLegend(root, f, users); };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
  });
  root.append(header);
  if (collapsed) return;
  if (f.mode === 'user') {
    if (!users.length) note(t('legend.noPlayers'));
    for (const u of users) {
      const d = document.createElement('div');
      d.className = 'li';
      const swatch = document.createElement('span');
      swatch.className = 'sw';
      swatch.style.background = rgbHex(uuidColor(u.uuid, u.nick));
      const name = document.createElement('span');
      name.textContent = u.nick ?? t('legend.unknownPlayer');
      d.append(swatch, name);
      root.append(d);
    }
  } else if (f.mode === 'action') {
    for (const k of ACTION_CODES) {
      const [src, a] = k.split(':');
      const d = document.createElement('div');
      d.className = 'li';
      const swatch = document.createElement('span');
      swatch.className = 'sw';
      swatch.style.background = rgbHex(actionColor(src, +a));
      const text = document.createElement('span');
      text.textContent = actionLabel(src, +a);
      d.append(swatch, text);
      root.append(d);
    }
  } else if (f.mode === 'material') {
    note(t('legend.materialHash'));
  } else {
    note(t('legend.timeGradient'));
  }
}

const LEGEND_COLLAPSED_KEY = 'legendCollapsed';

function loadLegendCollapsed() {
  try {
    return localStorage.getItem(LEGEND_COLLAPSED_KEY) === '1';
  } catch {
    return legendCollapsedFallback;
  }
}

// Без localStorage стан живе до перезавантаження сторінки.
let legendCollapsedFallback = false;
function saveLegendCollapsed(collapsed: boolean) {
  legendCollapsedFallback = collapsed;
  try {
    localStorage.setItem(LEGEND_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch { /* недоступний localStorage: лишається змінна модуля */ }
}
