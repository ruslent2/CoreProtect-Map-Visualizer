export const SERVER_LIMIT_MAX = 200000;

function toInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Видаляє налаштований префікс простору імен із відображуваної назви матеріалу або сутності. */
export function stripMaterialNamePrefix(name, prefixes = []) {
  const value = String(name ?? '');
  const match = prefixes.find(prefix => value.toLowerCase().startsWith(prefix));
  return match ? value.slice(match.length) : value;
}

/** Нормалізує публічну конфігурацію сервера, не змінюючи не пов’язані з нею параметри. */
export function normalizeConfig(config = {}) {
  const defaultLimit = clamp(toInteger(config.defaultLimit, 50000), 1, SERVER_LIMIT_MAX);
  const suppliedTiles = config.coreProtectTiles ?? {};
  
  // Використовує лише явно задані префікси; некоректне значення не видаляє жодного префікса.
  const materialNamePrefixesToStrip = (Array.isArray(config.materialNamePrefixesToStrip) ? config.materialNamePrefixesToStrip : [])
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  const rawTileSize = clamp(toInteger(suppliedTiles.tileSize, 256), 16, 2048);

  // Розміри плиток вирівнюються за блоками; округлення донизу є детермінованим і зберігає значення в межах діапазону.
  const tileSize = Math.max(16, Math.floor(rawTileSize / 16) * 16);
  const maxConcurrentRequests = clamp(toInteger(suppliedTiles.maxConcurrentRequests, 2), 1, 4);
  const detailPageSize = clamp(toInteger(suppliedTiles.detailPageSize, 5000), 100, Math.min(20000, SERVER_LIMIT_MAX));
  const maxTextureSize = Math.max(tileSize, toInteger(suppliedTiles.maxTextureSize, 512));

  return {
    ...config,
    defaultLimit,
    materialNamePrefixesToStrip,
    coreProtectTiles: {
      ...suppliedTiles,
      tileSize,
      maxConcurrentRequests,
      detailPageSize,
      maxTextureSize,
    },
  };
}
