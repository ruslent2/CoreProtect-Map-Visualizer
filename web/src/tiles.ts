import { Container, Sprite, Texture } from 'pixi.js';

// Слой подложки Bluemap: generic XYZ-в-мировых-координатах тайловый слой.
// Шаблон URL настраивается (разные версии Bluemap именуют тайлы по-разному):
// {world} {zoom} {x} {z}. Тайл zoom=0 покрывает blocksPerTileAtZoom0 блоков,
// каждый следующий zoom делит вдвое.
export interface BluemapConfig {
  enabled: boolean;
  baseUrl: string;
  tileTemplate: string;
  tileSize: number;
  blocksPerTileAtZoom0: number;
  maxZoom: number;
}

interface TileKey { z: number; tx: number; tz: number }

export class BluemapLayer {
  container = new Container();
  private cfg: BluemapConfig;
  private world = '';
  private tiles = new Map<string, Sprite>();
  private pending = new Set<string>();

  constructor(cfg: BluemapConfig) {
    this.cfg = cfg;
  }

  setWorld(world: string) { this.world = world; this.clear(); }
  clear() {
    for (const s of this.tiles.values()) s.destroy({ texture: true, textureSource: true });
    this.tiles.clear();
  }

  // Обновить видимые тайлы под текущую камеру (в блоках)
  update(view: { x1: number; z1: number; x2: number; z2: number; pxPerBlock: number }) {
    if (!this.cfg.enabled) return;
    const z = Math.min(this.cfg.maxZoom,
      Math.max(0, Math.ceil(Math.log2(this.cfg.tileSize / view.pxPerBlock))));
    const bpt = this.cfg.blocksPerTileAtZoom0 / (1 << z); // блоков на тайл
    const tx1 = Math.floor(view.x1 / bpt), tx2 = Math.floor(view.x2 / bpt);
    const tz1 = Math.floor(view.z1 / bpt), tz2 = Math.floor(view.z2 / bpt);
    if ((tx2 - tx1 + 1) * (tz2 - tz1 + 1) > 400) return; // слишком далеко — не грузим

    const need = new Set<string>();
    for (let tx = tx1; tx <= tx2; tx++) for (let tz = tz1; tz <= tz2; tz++) {
      need.add(this.k(z, tx, tz));
      this.load(z, tx, tz, bpt);
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

  private load(z: number, tx: number, tz: number, bpt: number) {
    const key = this.k(z, tx, tz);
    if (this.tiles.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    const url = this.cfg.baseUrl + this.cfg.tileTemplate
      .replace('{world}', encodeURIComponent(this.world))
      .replace('{zoom}', String(z))
      .replace('{x}', String(tx))
      .replace('{z}', String(tz));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.pending.delete(key);
      if (this.k(this.lastZ(), 0, 0) === '__stale__') return;
      const tex = Texture.from(img);
      tex.source.scaleMode = 'linear';
      const s = new Sprite(tex);
      s.position.set(tx * bpt, tz * bpt);
      s.width = bpt; s.height = bpt;
      s.alpha = 0.9;
      this.container.addChild(s);
      this.tiles.set(key, s);
    };
    img.onerror = () => this.pending.delete(key);
    img.src = url;
  }

  private lastZ() { return 0; }
}
