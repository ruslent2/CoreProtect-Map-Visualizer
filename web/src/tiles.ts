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
  /** Тайли, яких немає на сервері (порожні ділянки): вони теж вважаються «завантаженими». */
  private missing = new Set<string>();
  private view: { x1: number; z1: number; x2: number; z2: number } | null = null;
  private opacity = 0.9;

  constructor(cfg: BluemapConfig) {
    this.cfg = cfg;
    this.container.sortableChildren = true;
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
    this.missing.clear();
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
    // Тайли попереднього рівня лишаються на екрані, доки їх не перекриють тайли нового.
    this.zoom = z;
    this.view = view;
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

    for (let tx = tx1; tx <= tx2; tx++) for (let tz = tz1; tz <= tz2; tz++) {
      this.load(z, tx, tz, bpt, tileHeightBlocks);
    }
    this.prune();
  }

  private k(z: number, tx: number, tz: number) { return `${z}/${tx}/${tz}`; }

  private tileBlocks(z: number) {
    const width = this.cfg.blocksPerTileAtZoom0 * Math.pow(this.cfg.lodFactor, z - 1);
    return { width, height: width * this.cfg.tileAspectRatio };
  }

  /**
   * Вивантажує тайли поза екраном, а також тайли інших рівнів масштабу, щойно видиму
   * частину їхньої площі перекрили тайли поточного рівня (відсутній тайл теж перекриває).
   */
  private prune() {
    const view = this.view;
    if (!view) return;
    const current = this.tileBlocks(this.zoom);
    for (const [key, sprite] of this.tiles) {
      const [z, tx, tz] = key.split('/').map(Number);
      const size = this.tileBlocks(z);
      // Видима частина площі тайла в блоках.
      const x1 = Math.max(tx * size.width, view.x1), x2 = Math.min((tx + 1) * size.width, view.x2);
      const z1 = Math.max(tz * size.height, view.z1), z2 = Math.min((tz + 1) * size.height, view.z2);
      let remove = x1 > x2 || z1 > z2;
      if (!remove && z !== this.zoom) {
        remove = true;
        for (let cx = Math.floor(x1 / current.width); remove && cx <= Math.floor(x2 / current.width); cx++) {
          for (let cz = Math.floor(z1 / current.height); cz <= Math.floor(z2 / current.height); cz++) {
            const covering = this.k(this.zoom, cx, cz);
            if (!this.tiles.has(covering) && !this.missing.has(covering)) { remove = false; break; }
          }
        }
      }
      if (remove) {
        sprite.destroy({ texture: true, textureSource: true });
        this.tiles.delete(key);
      }
    }
  }

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
      // BlueMap imagery is pixel art; nearest-neighbour filtering preserves sharp blocks.
      tex.source.scaleMode = 'nearest';
      const s = new Sprite(tex);
      s.position.set(tx * bpt, tz * tileHeightBlocks);
      s.width = bpt; s.height = tileHeightBlocks;
      s.alpha = this.opacity;
      // Дрібніші тайли (менший zoom) лежать над грубішими, що ще не вивантажені.
      s.zIndex = -z;
      this.container.addChild(s);
      this.tiles.set(key, s);
      this.missing.delete(key);
      this.prune();
    };
    img.onerror = () => {
      this.pending.delete(key);
      if (generation === this.generation) {
        this.missing.add(key);
        this.prune();
      }
    };
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
