export interface TileCoordinate {
  x: number;
  z: number;
}

export interface TileBounds {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface TileEvent {
  src: string;
  rowid_src: number;
  x: number;
  z: number;
}

export function coordinateToTile(value: number, tileSize: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(tileSize) || tileSize <= 0) {
    throw new RangeError('Coordinates and tile size must be finite; tile size must be positive.');
  }
  return Math.floor(value / tileSize);
}

export function tileBounds(tile: TileCoordinate, tileSize: number): TileBounds {
  return {
    x1: tile.x * tileSize,
    z1: tile.z * tileSize,
    // x2/z2 are exclusive, preventing events on an edge from overlapping tiles.
    x2: (tile.x + 1) * tileSize,
    z2: (tile.z + 1) * tileSize,
  };
}

export function tileKey(tile: TileCoordinate): string {
  return `${tile.x}:${tile.z}`;
}

export function distributeEventsByTile<T extends TileEvent>(events: Iterable<T>, tileSize: number): Map<string, T[]> {
  const tiles = new Map<string, T[]>();
  for (const event of events) {
    const tile = { x: coordinateToTile(event.x, tileSize), z: coordinateToTile(event.z, tileSize) };
    const key = tileKey(tile);
    const bucket = tiles.get(key);
    if (bucket) bucket.push(event);
    else tiles.set(key, [event]);
  }
  return tiles;
}

export function sortOccupiedTiles(tiles: Iterable<TileCoordinate>, cameraTile: TileCoordinate): TileCoordinate[] {
  return [...tiles].sort((a, b) => {
    const distanceA = Math.abs(a.x - cameraTile.x) + Math.abs(a.z - cameraTile.z);
    const distanceB = Math.abs(b.x - cameraTile.x) + Math.abs(b.z - cameraTile.z);
    return distanceA - distanceB || a.x - b.x || a.z - b.z;
  });
}

/** Move a requested tile to the front while keeping a queue unique and stable otherwise. */
export function prioritizeTileQueue(queue: readonly string[], priority: string): string[] {
  return [priority, ...queue.filter(key => key !== priority)]
    .filter((key, index, values) => values.indexOf(key) === index);
}

export function eventId(event: Pick<TileEvent, 'src' | 'rowid_src'>): string {
  return `${event.src}:${event.rowid_src}`;
}

export function dedupeEvents<T extends TileEvent>(events: Iterable<T>): T[] {
  const seen = new Set<string>();
  return [...events].filter(event => {
    const id = eventId(event);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}