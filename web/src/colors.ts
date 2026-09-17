import SparkMD5 from 'spark-md5';

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
  'block:0': 'Руйнування', 'block:1': 'Встановлення', 'block:2': 'Взаємодія', 'block:3': 'Вбивство/руйнування сутності',
  'container:0': 'Вилучено з контейнера', 'container:1': 'Поміщено до контейнера',
  'item:2': 'Викинуто предмет', 'item:3': 'Підібрано предмет',
  'item:4': 'Вилучено з ендер-скрині', 'item:5': 'Поміщено до ендер-скрині',
  'item:6': 'Кинуто предмет', 'item:7': 'Вистрілено предметом',
  'item:8': 'Зламано інструмент або броню',
  'item:9': 'Крафт: покладено', 'item:10': 'Крафт: забрано',
  'item:11': 'Торгівля: віддано', 'item:12': 'Торгівля: отримано',
};

function rgbHexNum(n: number): [number, number, number] {
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// Відтворює java.util.UUID.hashCode() через XOR двох 64-бітних половин.
function uuidHashCode(uuid: string): number | null {
  const hex = uuid.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const most = BigInt(`0x${hex.slice(0, 16)}`);
  const least = BigInt(`0x${hex.slice(16)}`);
  const hilo = most ^ least;
  return Number(BigInt.asIntN(32, (hilo >> 32n) ^ hilo));
}

// Аналог Java UUID.nameUUIDFromBytes для імені офлайн-гравця (UUID v3, MD5).
function offlinePlayerUuidHashCode(username: string): number {
  const input = new TextEncoder().encode(`OfflinePlayer:${username}`);
  const digest = SparkMD5.ArrayBuffer.hash(input.buffer, true);
  const bytes = Uint8Array.from(digest, char => char.charCodeAt(0));
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return uuidHashCode(hex)!;
}

// Зберігає HSV-відтінок і насиченість, установлюючи brightness на 90%.
function normalizeBrightness90(rgb: [number, number, number]): [number, number, number] {
  const max = Math.max(...rgb);
  if (max === 0) return [230, 230, 230];
  const scale = (0.9 * 255) / max;
  return rgb.map(channel => Math.round(channel * scale)) as [number, number, number];
}

// UUID → колір маркера; за відсутності UUID генерується серверний offline UUID з ніку.
export function uuidColor(uuid: string | null, nick: string | null): [number, number, number] {
  const hash = uuid ? uuidHashCode(uuid) : null;
  const offlineHash = offlinePlayerUuidHashCode(nick || '#unknown');
  return normalizeBrightness90(rgbHexNum(hash ?? offlineHash));
}

const ACTION_COLORS: Record<string, [number, number, number]> = Object.fromEntries([
  ['block:0', 0xE53935], // руйнування — червоний
  ['block:1', 0x43A047], // встановлення — зелений
  ['block:2', 0xFDD835], // взаємодія — жовтий
  ['block:3', 0xD81B60], // вбивство сутності — рожево-червоний
  ['container:0', 0x1E88E5], // вилучення — синій
  ['container:1', 0x00ACC1], // поміщення — блакитний
  ['item:2', 0x8E24AA], // викидання
  ['item:3', 0x5E35B1], // підбирання
  ['item:4', 0x1976D2], // вилучення з ендер-скрині
  ['item:5', 0x00897B], // поміщення до ендер-скрині
  ['item:6', 0x3949AB], // кидання
  ['item:7', 0x6D4C41], // постріл
  ['item:8', 0xE53935], // поломка
  ['item:9', 0xF9A825], // покладено для крафту
  ['item:10', 0x7CB342], // забрано з крафту
  ['item:11', 0xFB8C00], // віддано в торгівлі
  ['item:12', 0x43A047], // отримано в торгівлі
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
