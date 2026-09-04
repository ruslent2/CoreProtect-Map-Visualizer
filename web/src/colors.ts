// Цветовая система с приоритетами режимов.
// Главный цвет определяется активным режимом окрашивания;
// вспомогательные измерения подмешиваются к нему (оттенок) и
// кодируются яркостью. Смешение — в HSL.

export type ColorMode = 'user' | 'action' | 'material' | 'time';

export interface EventLike {
  nick: string | null; uuid: string | null;
  src: string; action: number;
  material: string | null; time: number;
}

export const ACTION_LABELS: Record<string, string> = {
  'block:0': 'Разрушение', 'block:1': 'Установка', 'block:2': 'Взаимодействие', 'block:3': 'Прочее',
  'container:0': 'Изъято из контейнера', 'container:1': 'Помещено в контейнер',
  'item:0': 'Выброс предмета', 'item:1': 'Подбор предмета', 'item:2': 'Метание предмета',
  'entity:0': 'Убийство сущности',
};

function rgbHexNum(n: number): [number, number, number] {
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Палитра indexed-цветов Minecraft (как для имён/locator bar), порядок как в игре
const MC_PALETTE: [number, number, number][] = [
  0x00AAAA, 0x5555FF, 0xFF55FF, 0x00FFAA, 0xFF5555, 0xFFFF55,
  0x00AA00, 0xAAAAAA, 0x55FFFF, 0xAA00AA, 0xAA0000, 0xFFAA00,
  0xFFFF00, 0x55FF55, 0xFFAA55,
].map(rgbHexNum);

function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// UUID → цвет, как в игре (имена на табличках / locator bar):
// floor(hash(uuid) / 2^32) по модулю длины палитры, с поправкой на знак
export function uuidColor(uuid: string | null, nick: string | null): [number, number, number] {
  const key = uuid || nick || '#unknown';
  let i = Math.floor(javaHash(key) / 0x100000000) % MC_PALETTE.length;
  if (i < 0) i += MC_PALETTE.length;
  return MC_PALETTE[i];
}

const ACTION_COLORS: Record<string, [number, number, number]> = Object.fromEntries([
  ['block:0', 0xE53935], // break — красный
  ['block:1', 0x43A047], // place — зелёный
  ['block:2', 0xFDD835], // interact — жёлтый
  ['block:3', 0xFB8C00], // прочее — оранжевый
  ['container:0', 0x1E88E5], // изъятие — синий
  ['container:1', 0x00ACC1], // помещение — циан
  ['item:0', 0x8E24AA], // выброс
  ['item:1', 0x5E35B1], // подбор
  ['item:2', 0x3949AB], // метание
  ['entity:0', 0xD81B60], // убийство
].map(([k, v]) => [k, rgbHexNum(v as number)]));

export function actionColor(src: string, action: number): [number, number, number] {
  return ACTION_COLORS[`${src}:${action}`] ?? [0x9E9E9E];
}

export function materialColor(material: string | null): [number, number, number] {
  const h = javaHash(material ?? '#unknown');
  const hue = Math.abs(h) % 360;
  return hslToRgb(hue, 0.75, 0.55);
}

// Градиент времени: свежие — тёплые, старые — холодные
export function timeColor(t: number, tMin: number, tMax: number): [number, number, number] {
  const span = Math.max(1, tMax - tMin);
  const k = 1 - Math.min(1, Math.max(0, (t - tMin) / span)); // 1 = свежее
  return hslToRgb(220 + k * (-220 - -0), 0.85, 0.4 + k * 0.25);
}

// --- HSL утилиты ---
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function hueMix(h1: number, h2: number, k: number): number {
  let d = ((h2 - h1 + 540) % 360) - 180;
  return h1 + d * k;
}

export interface ColorContext {
  mode: ColorMode;
  mix: number;          // 0..0.5 — доля подмеса вторичного измерения
  tMin: number; tMax: number;
}

// Полный расчёт цвета события по приоритетам режима.
// Главный цвет — режим; вторичный — подмес оттенком; время — яркостью
// (кроме режима time, где время — главный, а вторичным идёт действие).
export function eventColor(e: EventLike, ctx: ColorContext): [number, number, number] {
  const secColor = ctx.mode === 'time'
    ? actionColor(e.src, e.action)
    : (ctx.mode === 'user' ? actionColor(e.src, e.action) : uuidColor(e.uuid, e.nick));
  let primary: [number, number, number];
  switch (ctx.mode) {
    case 'user': primary = uuidColor(e.uuid, e.nick); break;
    case 'action': primary = actionColor(e.src, e.action); break;
    case 'material': primary = materialColor(e.material); break;
    case 'time': primary = timeColor(e.time, ctx.tMin, ctx.tMax); break;
  }
  const [ph, ps, pl] = rgbToHsl(...primary);
  const [sh] = rgbToHsl(...secColor);
  const h = hueMix(ph, sh, ctx.mix);
  // давность → яркость: свежее ярче
  const span = Math.max(1, ctx.tMax - ctx.tMin);
  const recency = 1 - Math.min(1, Math.max(0, (e.time - ctx.tMin) / span));
  const l = Math.min(0.85, Math.max(0.3, 0.45 + recency * 0.35));
  return hslToRgb(h, Math.max(ps, 0.55), l);
}

export function rgbHex([r, g, b]: [number, number, number]): string {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
