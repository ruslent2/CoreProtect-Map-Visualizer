import type { Filters } from './state';
import type { ColorMode } from './colors';
import { uuidColor, actionColor, rgbHex, ACTION_LABELS } from './colors';

// Временная точка отсчёта: старая БД больше не пополняется.
// 2026-07-17 00:00:00 по локальному времени браузера.
const FILTER_NOW = new Date(2026, 6, 17, 0, 0, 0).getTime() / 1000;

type ChangeFn = (patch: Partial<Filters>) => void;

export interface MetaData {
  worlds: { id: number; world: string }[];
  users: { id: number; nick: string; uuid: string | null }[];
  materials: string[];
  actions: { id: string; label: string }[];
}

const MODE_LABELS: Record<ColorMode, string> = {
  user: 'Игроки (UUID→цвет)',
  action: 'Действия',
  material: 'Материалы',
  time: 'Время',
};

export function buildFilterPanel(
  root: HTMLElement, f: Filters, meta: MetaData, onChange: ChangeFn, onRefresh: () => void
) {
  root.innerHTML = '';
  const el = (html: string) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild as HTMLElement;
  };

  // --- Мир и режим ---
  root.append(el(`<h3>Мир</h3>`));
  const worldSel = el(`<select>${meta.worlds.map(w =>
    `<option value="${w.world}" ${w.world === f.world ? 'selected' : ''}>${w.world}</option>`).join('')}</select>`) as HTMLSelectElement;
  worldSel.onchange = () => onChange({ world: worldSel.value });
  root.append(worldSel);

  root.append(el(`<h3>Режим окрашивания (главный цвет)</h3>`));
  const modeSel = el(`<select>${(Object.keys(MODE_LABELS) as ColorMode[]).map(m =>
    `<option value="${m}" ${m === f.mode ? 'selected' : ''}>${MODE_LABELS[m]}</option>`).join('')}</select>`) as HTMLSelectElement;
  modeSel.onchange = () => onChange({ mode: modeSel.value as ColorMode });
  root.append(modeSel);

  const mixRow = el(`<div class="row"><span class="tiny">Подмес вторичного</span><input id="mix" type="range" min="0" max="50" value="${Math.round(f.mix * 100)}"><span class="tiny" id="mixv">${Math.round(f.mix * 100)}%</span></div>`);
  mixRow.querySelector<HTMLInputElement>('#mix')!.oninput = e => {
    const v = +(e.target as HTMLInputElement).value;
    mixRow.querySelector('#mixv')!.textContent = v + '%';
    onChange({ mix: v / 100 });
  };
  root.append(mixRow);

  // --- Время ---
  root.append(el(`<h3>Время</h3>`));
  const timeRow = el(`<div class="row">
    <button class="t-preset" data-h="24">24ч</button>
    <button class="t-preset" data-h="168">7д</button>
    <button class="t-preset" data-h="720">30д</button>
    <button id="t-clear" class="excl-toggle ${f.tFrom || f.tTo ? 'on' : ''}">всё время</button>
  </div>`);
  timeRow.querySelectorAll<HTMLButtonElement>('.t-preset').forEach(b => {
    b.onclick = () => onChange({ tTo: FILTER_NOW, tFrom: FILTER_NOW - Number(b.dataset.h) * 3600 });
  });
  (timeRow.querySelector('#t-clear') as HTMLButtonElement).onclick = () => onChange({ tFrom: null, tTo: null });
  root.append(timeRow);

  // --- Уровень Y ---
  root.append(el(`<h3>Уровень Y (пусто = все, проекция сверху)</h3>`));
  const yInput = el(`<input type="number" placeholder="например 64" value="${f.y ?? ''}">`) as HTMLInputElement;
  yInput.onchange = () => onChange({ y: yInput.value === '' ? null : +yInput.value });
  root.append(yInput);

  // --- Игроки ---
  root.append(el(`<h3>Игроки</h3>`));
  const userSel = makeMultiPicker(meta.users.map(u => ({
    key: u.nick, label: u.nick,
    color: rgbHex(uuidColor(u.uuid, u.nick)),
  })), f.users, v => onChange({ users: v }));
  const userExcl = makeExclToggle('usersExcl', f, onChange, 'Исключить выбранных');
  root.append(userExcl, userSel);

  // --- Действия ---
  root.append(el(`<h3>Действия</h3>`));
  const actSel = makeMultiPicker(meta.actions.map(a => {
    let key: [string, number] = ['block', 0];
    if (a.id.startsWith('container')) key = ['container', 0];
    else if (a.id.startsWith('item')) key = ['item', 0];
    else if (a.id === 'entity_kill') key = ['entity', 0];
    return { key: a.id, label: a.label, color: rgbHex(actionColor(key[0], key[1])) };
  }), f.actions, v => onChange({ actions: v }));
  const actExcl = makeExclToggle('actionsExcl', f, onChange, 'Исключить выбранные');
  root.append(actExcl, actSel);

  // --- Материалы ---
  root.append(el(`<h3>Материалы</h3>`));
  const matSel = makeMultiPicker(meta.materials.map(m => ({ key: m, label: m.replace('minecraft:', '') })), f.materials, v => onChange({ materials: v }));
  const matExcl = makeExclToggle('materialsExcl', f, onChange, 'Исключить выбранные');
  root.append(matExcl, matSel);

  // --- Область ---
  root.append(el(`<h3>Область</h3>`));
  const bboxRow = el(`<div class="row"><span class="tiny" id="bbox-info">${f.bbox ? bboxText(f.bbox) : 'не задана — выделите ПКМ-драгом'}</span><button id="bbox-clear">сброс</button></div>`);
  (bboxRow.querySelector('#bbox-clear') as HTMLButtonElement).onclick = () => onChange({ bbox: null });
  root.append(bboxRow);

  root.append(el(`<div class="row" style="margin-top:16px"><button class="primary" id="refresh">Обновить</button></div>`));
  (root.querySelector('#refresh') as HTMLButtonElement).onclick = onRefresh;

  // чипы выбранных
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
  search.type = 'text'; search.placeholder = 'поиск…';
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
    c.innerHTML = `<span>время</span><span class="x">✕</span>`;
    c.querySelector('.x')!.addEventListener('click', () => onChange({ tFrom: null, tTo: null }));
    chips.append(c);
  }
  root.append(chips);
}

export function buildLegend(root: HTMLElement, f: Filters, meta: MetaData) {
  root.innerHTML = `<div class="tiny" style="margin-bottom:4px">Главный цвет: режим</div>`;
  if (f.mode === 'user') {
    for (const u of meta.users.slice(0, 40)) {
      const d = document.createElement('div');
      d.className = 'li';
      d.innerHTML = `<span class="sw" style="background:${rgbHex(uuidColor(u.uuid, u.nick))}"></span><span>${u.nick}</span>`;
      root.append(d);
    }
    if (meta.users.length > 40) root.innerHTML += `<div class="tiny">…и ещё ${meta.users.length - 40}</div>`;
  } else if (f.mode === 'action') {
    for (const [k, label] of Object.entries(ACTION_LABELS)) {
      const [src, a] = k.split(':');
      const d = document.createElement('div');
      d.className = 'li';
      d.innerHTML = `<span class="sw" style="background:${rgbHex(actionColor(src, +a))}"></span><span>${label}</span>`;
      root.append(d);
    }
  } else if (f.mode === 'material') {
    root.innerHTML = `<div class="tiny">цвет = хэш материала; яркость = свежесть</div>`;
  } else {
    root.innerHTML = `<div class="tiny">свежие — тёплые, старые — холодные; подмес = действие</div>`;
  }
}
