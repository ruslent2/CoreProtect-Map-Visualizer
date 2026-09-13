import { Container, Sprite, Texture } from 'pixi.js';

// Слой подложки Bluemap: generic XYZ-в-мировых-координатах тайловый слой.
// Шаблон URL настраивается (разные версии Bluemap именуют тайлы по-разному):
// {world} {zoom} {x} {z}. У BlueMap после обрезки верхней половины PNG
// один тайл содержит 501×501 пикселей; масштаб каждого следующего уровня
// увеличивает покрытие одного пикселя в 5 раз.
export interface BluemapConfig {
  enabled: boolean;
  baseUrl: string;
  tileTemplate: string;
  tileSize: number;
  tileAspectRatio: number;
  blocksPerTileAtZoom0: number;
  lodFactor: number;
  maxZoom: number;
}

interface TileKey { z: number; tx: number; tz: number }

/** Keeps UI input and sprites inside Pixi's supported alpha range. */
export function normalizeBluemapOpacity(alpha: number): number {
  return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0.9;
}

export class BluemapLayer {
  container = new Container();
  private cfg: BluemapConfig;
  private world = '';
  private generation = 0;
  private zoom = -1;
  private lastView = '';
  private tiles = new Map<string, Sprite>();
  private pending = new Set<string>();
  private opacity = 0.9;

  constructor(cfg: BluemapConfig) {
    this.cfg = cfg;
  }

  setWorld(world: string) {
    if (this.world === world) return;
    this.world = world;
    this.generation++;
    this.zoom = -1;
    this.clear();
  }
  clear() {
    this.generation++;
    this.pending.clear();
    this.lastView = '';
    for (const s of this.tiles.values()) s.destroy({ texture: true, textureSource: true });
    this.tiles.clear();
  }

  /** Updates loaded and future BlueMap tiles without changing the requested view. */
  setOpacity(alpha: number) {
    this.opacity = normalizeBluemapOpacity(alpha);
    for (const sprite of this.tiles.values()) sprite.alpha = this.opacity;
  }

  // Обновить видимые тайлы под текущую камеру (в блоках)
  update(view: { x1: number; z1: number; x2: number; z2: number; pxPerBlock: number }) {
    if (!this.cfg.enabled) return;
    const baseBlocks = this.cfg.blocksPerTileAtZoom0;
    const desiredBlocksPerTile = this.cfg.tileSize / Math.max(0.01, view.pxPerBlock);
    const lod = Math.round(Math.log(Math.max(1, desiredBlocksPerTile) / baseBlocks) / Math.log(this.cfg.lodFactor));
    // zoom=1: 1 пиксель = 1 блок; zoom=2: 1 = 5 блоков;
    // zoom=3: 1 = 25 блоков.
    const z = Math.min(this.cfg.maxZoom,
      Math.max(1, 1 + lod));
    if (z !== this.zoom) {
      this.zoom = z;
      this.clear();
    }
    const viewKey = `${z}:${Math.floor(view.x1)}:${Math.floor(view.z1)}:${Math.ceil(view.x2)}:${Math.ceil(view.z2)}`;
    if (viewKey === this.lastView) return;
    this.lastView = viewKey;
    const generation = this.generation;
    // zoom=1: 501 блока на грань, zoom=2: 2505, zoom=3: 12525.
    const bpt = this.cfg.blocksPerTileAtZoom0 * Math.pow(this.cfg.lodFactor, z - 1);
    const tileHeightBlocks = bpt * this.cfg.tileAspectRatio;
    const tx1 = Math.floor(view.x1 / bpt), tx2 = Math.floor(view.x2 / bpt);
    const tz1 = Math.floor(view.z1 / tileHeightBlocks), tz2 = Math.floor(view.z2 / tileHeightBlocks);
    if ((tx2 - tx1 + 1) * (tz2 - tz1 + 1) > 400) return; // слишком далеко — не грузим

    const need = new Set<string>();
    for (let tx = tx1; tx <= tx2; tx++) for (let tz = tz1; tz <= tz2; tz++) {
      need.add(this.k(z, tx, tz));
      this.load(z, tx, tz, bpt, tileHeightBlocks);
    }
    // выгрузить невидимые
    for (const [key, s] of this.tiles) {
      if (!need.has(key)) {
        s.destroy({ texture: true, textureSource: true });
        this.tiles.delete(key);
      }
    }
  }

  private k(z: number, tx: number, tz: number) { return `${z}/${tx}/${tz}`; }

  private load(z: number, tx: number, tz: number, bpt: number, tileHeightBlocks: number) {
    const key = this.k(z, tx, tz);
    if (this.tiles.has(key) || this.pending.has(key)) return;
    const generation = this.generation;
    this.pending.add(key);
    const prefix = this.cfg.tileTemplate.startsWith('/') ? '' : this.cfg.baseUrl;
    const url = prefix + this.cfg.tileTemplate
      .replace('{world}', encodeURIComponent(this.world))
      .replace('{zoom}', String(z))
      .replace('{x}', String(tx))
      .replace('{z}', String(tz));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.pending.delete(key);
      if (generation !== this.generation || z !== this.zoom) return;
      const source = this.cropMapHalf(img);
      const tex = Texture.from(source);
      tex.source.scaleMode = 'linear';
      const s = new Sprite(tex);
      s.position.set(tx * bpt, tz * tileHeightBlocks);
      s.width = bpt; s.height = tileHeightBlocks;
      s.alpha = this.opacity;
      this.container.addChild(s);
      this.tiles.set(key, s);
    };
    img.onerror = () => this.pending.delete(key);
    img.src = url;
  }

  private cropMapHalf(img: HTMLImageElement): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    // Bluemap отдаёт вертикальный spritesheet: карта находится сверху,
    // нижняя половина содержит карту высот и в проект не попадает.
    cv.height = Math.floor(img.naturalHeight / 2);
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, img.naturalWidth, cv.height,
      0, 0, cv.width, cv.height);
    return cv;
  }
}
