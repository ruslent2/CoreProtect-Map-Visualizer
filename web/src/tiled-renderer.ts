import type { Chunk, CpEvent } from './api';
import { coordinateToTile, dedupeEvents, tileBounds, type TileCoordinate } from './tile-utils';

/** Configuration shared by the Pixi tile renderer and its pure planning seam. */
export interface TileRendererConfig {
  tileSize: number;
  maxTextureSize: number;
}

export const DEFAULT_TILE_RENDERER_CONFIG: TileRendererConfig = {
  tileSize: 256,
  maxTextureSize: 4096,
};

export const MINECRAFT_CHUNK_SIZE = 16;
export const LOD_CELL_SIZE = MINECRAFT_CHUNK_SIZE;
export const MIN_LOD_MARKER_SCREEN_PX = 7;

/** Detail rasters are sub-pixel below this scale, so use the local LOD overlay. */
export function shouldShowLodOverlay(scale: number): boolean {
  return Number.isFinite(scale) && scale > 0 && scale < 1;
}

/** Applies the local marker preference without changing normal render layers. */
export function shouldDisplayLodMarkers(enabled: boolean, scale: number): boolean {
  return enabled && shouldShowLodOverlay(scale);
}

export interface DetailLodCell {
  x: number;
  z: number;
  event: CpEvent;
}

export interface AggregateLodCell {
  x: number;
  z: number;
  chunk: Chunk;
}

/**
 * Groups loaded events in chunk-sized world cells. The newest event represents a
 * cell so its colour remains meaningful while a single isolated event is kept.
 */
export function detailLodCells(events: Iterable<CpEvent>, cellSize = LOD_CELL_SIZE): DetailLodCell[] {
  const cells = new Map<string, DetailLodCell>();
  for (const event of events) {
    const x = coordinateToTile(event.x, cellSize) * cellSize;
    const z = coordinateToTile(event.z, cellSize) * cellSize;
    const key = `${x}:${z}`;
    const existing = cells.get(key);
    if (!existing || event.time >= existing.event.time) cells.set(key, { x, z, event });
  }
  return [...cells.values()];
}

/** Aggregates are already chunk-sized; retain the busiest chunk on malformed duplicates. */
export function aggregateLodCells(chunks: Iterable<Chunk>): AggregateLodCell[] {
  const cells = new Map<string, AggregateLodCell>();
  for (const chunk of chunks) {
    const x = chunk.cx * MINECRAFT_CHUNK_SIZE, z = chunk.cz * MINECRAFT_CHUNK_SIZE;
    const key = `${x}:${z}`;
    const existing = cells.get(key);
    if (!existing || chunk.cnt >= existing.chunk.cnt) cells.set(key, { x, z, chunk });
  }
  return [...cells.values()];
}

export interface RasterPart {
  x: number;
  z: number;
  width: number;
  height: number;
}

/**
 * Splits one transport tile into texture-safe local rectangles. Rasterization must
 * use these parts rather than an event/result bounding box.
 */
export function tileRasterParts(tileSize: number, maxTextureSize: number): RasterPart[] {
  if (!Number.isInteger(tileSize) || tileSize <= 0 || !Number.isInteger(maxTextureSize) || maxTextureSize <= 0) {
    throw new RangeError('Tile and maximum texture sizes must be positive integers.');
  }
  const parts: RasterPart[] = [];
  for (let z = 0; z < tileSize; z += maxTextureSize) {
    for (let x = 0; x < tileSize; x += maxTextureSize) {
      parts.push({ x, z, width: Math.min(maxTextureSize, tileSize - x), height: Math.min(maxTextureSize, tileSize - z) });
    }
  }
  return parts;
}

export interface TileHitIndex {
  events: CpEvent[];
  byBlock: Map<string, CpEvent[]>;
}

export function createEventHitIndex(events: Iterable<CpEvent>): TileHitIndex {
  const unique = dedupeEvents(events);
  const byBlock = new Map<string, CpEvent[]>();
  for (const event of unique) {
    const key = `${Math.floor(event.x)},${Math.floor(event.z)}`;
    const block = byBlock.get(key);
    if (block) block.push(event);
    else byBlock.set(key, [event]);
  }
  return { events: unique, byBlock };
}

export interface TileResource {
  destroy(): void;
}

export interface DetailTileState {
  resources: TileResource[];
  events: CpEvent[];
  hitIndex: Map<string, CpEvent[]>;
}

export interface AggregateTileState {
  resources: TileResource[];
  chunks: Chunk[];
}

/**
 * Resource ownership and generation gate without a DOM/Pixi dependency. MapView
 * supplies Sprite resources; tests can supply inexpensive fakes.
 */
export class TiledRenderState {
  readonly detailTiles = new Map<string, DetailTileState>();
  readonly aggregateTiles = new Map<string, AggregateTileState>();
  private stagingGeneration: number | null = null;
  private committedGeneration: number | null = null;
  private stagedDetail = new Map<string, DetailTileState>();
  private stagedAggregate = new Map<string, AggregateTileState>();

  begin(generation: number): void {
    if (this.stagingGeneration === generation) return;
    this.cancel();
    this.stagingGeneration = generation;
  }

  canMutate(generation: number): boolean {
    return this.stagingGeneration === generation;
  }

  stageDetail(generation: number, key: string, state: DetailTileState): boolean {
    if (!this.canMutate(generation)) return false;
    this.replace(this.stagedDetail, key, state);
    return true;
  }

  stageAggregate(generation: number, key: string, state: AggregateTileState): boolean {
    if (!this.canMutate(generation)) return false;
    this.replace(this.stagedAggregate, key, state);
    return true;
  }

  removeDetail(generation: number, key: string): boolean {
    if (!this.canMutate(generation)) return false;
    this.remove(this.stagedDetail, key);
    return true;
  }

  /** Installs a detail tile over an already committed aggregate overview. */
  installDetail(generation: number, key: string, state: DetailTileState): boolean {
    if (this.stagingGeneration !== null || generation !== this.committedGeneration) return false;
    this.replace(this.detailTiles, key, state);
    return true;
  }

  commit(generation: number): boolean {
    if (!this.canMutate(generation)) return false;
    this.clearMap(this.detailTiles);
    this.clearMap(this.aggregateTiles);
    this.detailTiles.clear();
    this.aggregateTiles.clear();
    for (const [key, state] of this.stagedDetail) this.detailTiles.set(key, state);
    for (const [key, state] of this.stagedAggregate) this.aggregateTiles.set(key, state);
    this.stagedDetail = new Map();
    this.stagedAggregate = new Map();
    this.stagingGeneration = null;
    this.committedGeneration = generation;
    return true;
  }

  cancel(generation?: number): boolean {
    if (generation != null && !this.canMutate(generation)) return false;
    this.clearMap(this.stagedDetail);
    this.clearMap(this.stagedAggregate);
    this.stagedDetail = new Map();
    this.stagedAggregate = new Map();
    this.stagingGeneration = null;
    return true;
  }

  clear(): void {
    this.cancel();
    this.clearMap(this.detailTiles);
    this.clearMap(this.aggregateTiles);
    this.detailTiles.clear();
    this.aggregateTiles.clear();
    this.committedGeneration = null;
  }

  private replace<T extends { resources: TileResource[] }>(map: Map<string, T>, key: string, state: T): void {
    this.remove(map, key);
    map.set(key, state);
  }

  private remove<T extends { resources: TileResource[] }>(map: Map<string, T>, key: string): void {
    const old = map.get(key);
    if (!old) return;
    old.resources.forEach(resource => resource.destroy());
    map.delete(key);
  }

  private clearMap<T extends { resources: TileResource[] }>(map: Map<string, T>): void {
    for (const state of map.values()) state.resources.forEach(resource => resource.destroy());
  }
}

export function tileOriginFromKey(key: string, tileSize: number): { x1: number; z1: number; x2: number; z2: number } {
  const [xText, zText, ...rest] = key.split(':');
  const x = Number(xText), z = Number(zText);
  if (rest.length || !Number.isInteger(x) || !Number.isInteger(z)) throw new RangeError(`Invalid tile key: ${key}`);
  const tile: TileCoordinate = { x, z };
  const bounds = tileBounds(tile, tileSize);
  return { x1: bounds.x1, z1: bounds.z1, x2: bounds.x2, z2: bounds.z2 };
}

export function tileKeyForBlock(x: number, z: number, tileSize: number): string {
  return `${coordinateToTile(x, tileSize)}:${coordinateToTile(z, tileSize)}`;
}
