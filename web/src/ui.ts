import type { Filters, TimeSelection } from './state';
import { epochSecondsToLocalDateTime, localDateTimeToEpochSeconds, presetTimeSelection } from './state';
import type { ColorMode } from './colors';
import { uuidColor, actionColor, rgbHex, ACTION_LABELS } from './colors';

type ChangeFn = (patch: Partial<Filters>) => void;
type TimeChangeFn = (time: TimeSelection, preserveEditor?: boolean) => void;
export interface ScanControls { status: string; error?: string | null; canShowAll: boolean; canStop: boolean; canContinueDetails: boolean; bluemapOpacity: number; lodMarkersVisible: boolean; onBluemapOpacity(alpha: number): void; onLodMarkersVisible(enabled: boolean): void; onApply(): void; onStop(): void; onContinueDetails(): void; onShowAll(): void; }

export interface MetaData {
  worlds: { id: number; world: string }[];
  users: { id: number; nick: string; uuid: string | null }[];
  materials: string[];
  actions: { id: string; label: string; src: string; action: number }[];
}

const MODE_LABELS: Record<ColorMode, string> = {
  user: 'Гравці (UUID→колір)',
  action: 'Дії',
  material: 'Матеріали',
  time: 'Час',
};

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

export function buildFilterPanel(
  root: HTMLElement, f: Filters, time: TimeSelection, meta: MetaData, onChange: ChangeFn, onTimeChange: TimeChangeFn, controls: ScanControls
) {
  root.innerHTML = '';
  const el = (html: string) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild as HTMLElement;
  };

  // --- Світ і режим ---
  root.append(el(`<h3>Світ</h3>`));
  const worldSel = el(`<select>${meta.worlds.map(w =>
    `<option value="${w.world}" ${w.world === f.world ? 'selected' : ''}>${w.world}</option>`).join('')}</select>`) as HTMLSelectElement;
  worldSel.onchange = () => onChange({ world: worldSel.value });
  root.append(worldSel);

  root.append(el(`<h3>Режим забарвлення (основний колір)</h3>`));
  const modeSel = el(`<select>${(Object.keys(MODE_LABELS) as ColorMode[]).map(m =>
    `<option value="${m}" ${m === f.mode ? 'selected' : ''}>${MODE_LABELS[m]}</option>`).join('')}</select>`) as HTMLSelectElement;
  modeSel.onchange = () => onChange({ mode: modeSel.value as ColorMode });
  root.append(modeSel);

  const mixRow = el(`<div class="row"><span class="tiny">Домішування вторинного</span><input id="mix" type="range" min="0" max="50" value="${Math.round(f.mix * 100)}"><span class="tiny" id="mixv">${Math.round(f.mix * 100)}%</span></div>`);
  mixRow.querySelector<HTMLInputElement>('#mix')!.oninput = e => {
    const v = +(e.target as HTMLInputElement).value;
    mixRow.querySelector('#mixv')!.textContent = v + '%';
    onChange({ mix: v / 100 });
  };
  root.append(mixRow);

  // Локальне налаштування підкладки: не змінює фільтр і не запускає запити.
  root.append(el(`<h3>Підкладка BlueMap</h3>`));
  const opacityRow = el(`<div class="row opacity-control"><span class="tiny">Прозорість</span><input id="bluemap-opacity" type="range" min="0" max="100" value="${Math.round(controls.bluemapOpacity * 100)}"><span class="tiny" id="bluemap-opacity-value">${Math.round(controls.bluemapOpacity * 100)}%</span></div>`);
  opacityRow.querySelector<HTMLInputElement>('#bluemap-opacity')!.oninput = event => {
    const value = Number((event.target as HTMLInputElement).value) / 100;
    opacityRow.querySelector('#bluemap-opacity-value')!.textContent = `${Math.round(value * 100)}%`;
    controls.onBluemapOpacity(value);
  };
  root.append(opacityRow);
  const lodMarkersRow = el(`<label class="row lod-markers-control"><input id="lod-markers-visible" type="checkbox" ${controls.lodMarkersVisible ? 'checked' : ''}><span class="tiny">Показувати LOD-маркери</span></label>`);
  lodMarkersRow.querySelector<HTMLInputElement>('#lod-markers-visible')!.onchange = event => {
    controls.onLodMarkersVisible((event.target as HTMLInputElement).checked);
  };
  root.append(lodMarkersRow);

  // --- Час ---
  root.append(el(`<h3>Час</h3>`));
  const isPreset = (hours: number) => time.mode === 'range' && time.from != null && time.to != null && time.to - time.from === hours * 3600;
  const timeRow = el(`<div class="row">
    <button class="t-preset ${isPreset(6) ? 'active' : ''}" data-h="6">6ч</button>
    <button class="t-preset ${isPreset(24) ? 'active' : ''}" data-h="24">24ч</button>
    <button class="t-preset ${isPreset(168) ? 'active' : ''}" data-h="168">7д</button>
    <button class="t-preset ${isPreset(720) ? 'active' : ''}" data-h="720">30д</button>
    <button id="t-clear" class="excl-toggle ${time.mode === 'all' ? 'on' : ''}">Увесь час</button>
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
  root.append(el(`<h3>Рівень Y (порожньо = усі, проєкція згори)</h3>`));
  const yInput = el(`<input type="number" placeholder="наприклад, 64" value="${f.y ?? ''}">`) as HTMLInputElement;
  yInput.onchange = () => onChange({ y: yInput.value === '' ? null : +yInput.value });
  root.append(yInput);

  // --- Гравці ---
  root.append(el(`<h3>Гравці</h3>`));
  const userPatterns = document.createElement('textarea');
  userPatterns.className = 'pattern-input';
  userPatterns.rows = 5;
  userPatterns.placeholder = 'по одному шаблону на рядок…';
  userPatterns.value = f.users.join('\n');
  userPatterns.title = 'Підтримуються * і ?. ! на початку виключає шаблон. (?i) робить зіставлення чутливим до регістру.';
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
  root.append(el(`<div class="tiny pattern-help">* — будь-які символи, ? — один символ, ! — виключити, (?i) — враховувати регістр</div>`));

  // --- Матеріали ---
  root.append(el(`<h3>Матеріали</h3>`));
  const materialPatterns = document.createElement('textarea');
  materialPatterns.className = 'pattern-input';
  materialPatterns.rows = 5;
  materialPatterns.placeholder = 'по одному шаблону на рядок…';
  materialPatterns.value = f.materials.join('\n');
  materialPatterns.title = 'Підтримуються * і ?. ! на початку виключає шаблон. (?i) робить зіставлення чутливим до регістру.';
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
  root.append(el(`<div class="tiny pattern-help">* — будь-які символи, ? — один символ, ! — виключити, (?i) — враховувати регістр</div>`));
  const matExcl = makeExclToggle('materialsExcl', f, onChange, 'Виключити вибрані');
  root.append(matExcl);

  // --- Дії ---
  root.append(el(`<h3>Дії</h3>`));
  // Сервер передає точну пару джерело/код, тому колір відповідає вибраній дії.
  const actionItems = meta.actions.map(a => ({
    key: a.id,
    label: a.label,
    color: rgbHex(actionColor(a.src, a.action)),
  }));
  const actSel = makeCheckboxPicker(actionItems, f.actions, v => onChange({ actions: v }));
  const actExcl = makeExclToggle('actionsExcl', f, onChange, 'Виключити вибрані');
  root.append(actExcl, actSel);

  // --- Ділянка ---
  root.append(el(`<h3>Ділянка</h3>`));
  const bboxRow = el(`<div class="row"><span class="tiny" id="bbox-info">${f.bbox ? bboxText(f.bbox) : 'не задано — виділіть перетягуванням ПКМ'}</span><button id="bbox-clear">скинути</button></div>`);
  (bboxRow.querySelector('#bbox-clear') as HTMLButtonElement).onclick = () => onChange({ bbox: null });
  root.append(bboxRow);

  const scanRow = el(`<div class="scan-controls"><div class="tiny">${controls.status}</div><div class="row"><button class="primary" id="refresh">Оновити дані</button>${controls.canShowAll ? '<button id="show-all">Показати всі результати</button>' : ''}${controls.canContinueDetails ? '<button id="continue-details">Продовжити деталізацію</button>' : ''}${controls.canStop ? '<button id="stop">Зупинити</button>' : ''}</div></div>`);
  (scanRow.querySelector('#refresh') as HTMLButtonElement).onclick = controls.onApply;
  (scanRow.querySelector('#show-all') as HTMLButtonElement | null)?.addEventListener('click', controls.onShowAll);
  (scanRow.querySelector('#continue-details') as HTMLButtonElement | null)?.addEventListener('click', controls.onContinueDetails);
  (scanRow.querySelector('#stop') as HTMLButtonElement | null)?.addEventListener('click', controls.onStop);
  root.append(scanRow);

  // Чипи вибраних значень
  renderChips(root, f, onChange);
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
  search.type = 'text'; search.placeholder = 'пошук…';
  const list = document.createElement('div');
  list.className = 'list-picker';
  const render = (q: string) => {
    list.innerHTML = '';
    const flt = items.filter(i => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
    for (const it of flt) {
      const d = document.createElement('div');
      d.className = 'item' + (selected.includes(it.key) ? ' sel' : '');
      d.innerHTML = `${it.color ? `<span class="dot" style="background:${it.color}"></span>` : ''}<span>${it.label}</span>`;
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

function makeCheckboxPicker(items: PickItem[], selected: string[], onSel: (v: string[]) => void) {
  const wrap = document.createElement('div');
  wrap.className = 'checkbox-picker';

  const allLabel = document.createElement('label');
  allLabel.className = 'checkbox-item checkbox-all';
  const all = document.createElement('input');
  all.type = 'checkbox';
  all.checked = items.length > 0 && items.every(item => selected.includes(item.key));
  all.indeterminate = selected.length > 0 && !all.checked;
  all.onchange = () => onSel(all.checked ? items.map(item => item.key) : []);
  allLabel.append(all, document.createTextNode('Усі дії'));
  wrap.append(allLabel);

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
      c.innerHTML = `<span>${v}</span><span class="x">✕</span>`;
      c.querySelector('.x')!.addEventListener('click', () => onChange({ [listKey]: f[listKey].filter(x => x !== v) } as Partial<Filters>));
      chips.append(c);
    }
  };
  mk('users'); mk('actions'); mk('materials');
  if (f.tFrom || f.tTo) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `<span>час</span><span class="x">✕</span>`;
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
  root.innerHTML = `<div class="tiny" style="margin-bottom:4px">Основний колір: ${MODE_LABELS[f.mode]}</div>`;
  if (f.mode === 'user') {
    if (!users.length) root.innerHTML += `<div class="tiny">Гравців у результатах немає</div>`;
    for (const u of users) {
      const d = document.createElement('div');
      d.className = 'li';
      const swatch = document.createElement('span');
      swatch.className = 'sw';
      swatch.style.background = rgbHex(uuidColor(u.uuid, u.nick));
      const name = document.createElement('span');
      name.textContent = u.nick ?? 'Невідомий гравець';
      d.append(swatch, name);
      root.append(d);
    }
  } else if (f.mode === 'action') {
    for (const [k, label] of Object.entries(ACTION_LABELS)) {
      const [src, a] = k.split(':');
      const d = document.createElement('div');
      d.className = 'li';
      d.innerHTML = `<span class="sw" style="background:${rgbHex(actionColor(src, +a))}"></span><span>${label}</span>`;
      root.append(d);
    }
  } else if (f.mode === 'material') {
    root.innerHTML = `<div class="tiny">колір = хеш матеріалу; яскравість = свіжість</div>`;
  } else {
    root.innerHTML = `<div class="tiny">нові — теплі, старі — холодні; домішування = дія</div>`;
  }
}
