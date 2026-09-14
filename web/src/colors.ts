// Система кольорів із пріоритетами режимів.
// Основний колір визначається активним режимом забарвлення;
// допоміжні виміри домішуються до нього (відтінком) і
// кодуються яскравістю. Змішування — у HSL.

export type ColorMode = 'user' | 'action' | 'material' | 'time';

export interface EventLike {
  nick: string | null; uuid: string | null;
  src: string; action: number;
  material: string | null; time: number;
}

export const ACTION_LABELS: Record<string, string> = {
  'block:0': 'Руйнування', 'block:1': 'Встановлення', 'block:2': 'Взаємодія', 'block:3': 'Інше',
  'container:0': 'Вилучено з контейнера', 'container:1': 'Поміщено до контейнера',
  'item:0': 'Викидання предмета', 'item:1': 'Підбирання предмета', 'item:2': 'Кидання предмета',
  'entity:0': 'Вбивство сутності',
};

function rgbHexNum(n: number): [number, number, number] {
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Палітра індексованих кольорів Minecraft (як для імен / панелі локатора), порядок як у грі
// переробити з https://ru.minecraft.wiki/w/%D0%9A%D0%B0%D0%BB%D1%8C%D0%BA%D1%83%D0%BB%D1%8F%D1%82%D0%BE%D1%80%D1%8B/UUID
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

// UUID → колір, як у грі (імена на табличках / панелі локатора):
// floor(hash(uuid) / 2^32) за модулем довжини палітри, з поправкою на знак
// переробити з https://ru.minecraft.wiki/w/%D0%9A%D0%B0%D0%BB%D1%8C%D0%BA%D1%83%D0%BB%D1%8F%D1%82%D0%BE%D1%80%D1%8B/UUID
export function uuidColor(uuid: string | null, nick: string | null): [number, number, number] {
  const key = uuid || nick || '#unknown';
  let i = Math.floor(javaHash(key) / 0x100000000) % MC_PALETTE.length;
  if (i < 0) i += MC_PALETTE.length;
  return MC_PALETTE[i];
}

const ACTION_COLORS: Record<string, [number, number, number]> = Object.fromEntries([
  ['block:0', 0xE53935], // руйнування — червоний
  ['block:1', 0x43A047], // встановлення — зелений
  ['block:2', 0xFDD835], // взаємодія — жовтий
  ['block:3', 0xFB8C00], // інше — помаранчевий
  ['container:0', 0x1E88E5], // вилучення — синій
  ['container:1', 0x00ACC1], // поміщення — блакитний
  ['item:0', 0x8E24AA], // викидання
  ['item:1', 0x5E35B1], // підбирання
  ['item:2', 0x3949AB], // кидання
  ['entity:0', 0xD81B60], // вбивство
].map(([k, v]) => [k, rgbHexNum(v as number)]));

export function actionColor(src: string, action: number): [number, number, number] {
  return ACTION_COLORS[`${src}:${action}`] ?? [0x9E9E9E];
}

export function materialColor(material: string | null): [number, number, number] {
  const h = javaHash(material ?? '#unknown');
  const hue = Math.abs(h) % 360;
  return hslToRgb(hue, 0.75, 0.55);
}

// Градієнт часу: нові — теплі, старі — холодні
export function timeColor(t: number, tMin: number, tMax: number): [number, number, number] {
  const span = Math.max(1, tMax - tMin);
  const k = 1 - Math.min(1, Math.max(0, (t - tMin) / span)); // 1 = новіше
  return hslToRgb(220 + k * (-220 - -0), 0.85, 0.4 + k * 0.25);
}

// --- Утиліти HSL ---
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
  mix: number;          // 0..0.5 — частка домішування вторинного виміру
  tMin: number; tMax: number;
}

// Повний розрахунок кольору події за пріоритетами режиму.
// Основний колір — режим; вторинний — домішування відтінком; час — яскравістю
// (крім режиму time, де основним є час, а вторинною — дія).
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
  // Давність → яскравість: новіші події яскравіші
  const span = Math.max(1, ctx.tMax - ctx.tMin);
  const recency = 1 - Math.min(1, Math.max(0, (e.time - ctx.tMin) / span));
  const l = Math.min(0.85, Math.max(0.3, 0.45 + recency * 0.35));
  return hslToRgb(h, Math.max(ps, 0.55), l);
}

export function rgbHex([r, g, b]: [number, number, number]): string {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
