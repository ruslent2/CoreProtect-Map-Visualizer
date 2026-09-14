export const SERVER_LIMIT_MAX = 200000;

function toInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Removes a configured namespace prefix from a material or entity display name. */
export function stripMaterialNamePrefix(name, prefixes = []) {
  const value = String(name ?? '');
  const match = prefixes.find(prefix => value.toLowerCase().startsWith(prefix));
  return match ? value.slice(match.length) : value;
}

/** Normalizes the public server configuration without changing unrelated settings. */
export function normalizeConfig(config = {}) {
  const defaultLimit = clamp(toInteger(config.defaultLimit, 50000), 1, SERVER_LIMIT_MAX);
  const suppliedTiles = config.coreProtectTiles ?? {};
  // Remove the vanilla namespace from labels; [] preserves complete material names.
  const materialNamePrefixesToStrip = (Array.isArray(config.materialNamePrefixesToStrip) ? config.materialNamePrefixesToStrip : ['minecraft:'])
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  const rawTileSize = clamp(toInteger(suppliedTiles.tileSize, 256), 16, 2048);
  // Tile dimensions are block-aligned; flooring is deterministic and keeps the value in range.
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
