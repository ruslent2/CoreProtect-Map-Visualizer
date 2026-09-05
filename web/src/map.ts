import { Application, Container, Sprite, Texture, Graphics } from 'pixi.js';
import type { Filters } from './state';
import type { CpEvent, Chunk } from './api';
import { eventColor, actionColor, uuidColor, type ColorContext } from './colors';

const MIN_SCALE = 1 / 16; // 1 пиксель = 16 блоков; обзор чанков остаётся читаемым
const MAX_SCALE = 64;

export interface MapCallbacks {
  onHover: (evs: CpEvent[] | null, screenX: number, screenY: number) => void;
  onClick: (evs: CpEvent[]) => void;
  onSelection: (bbox: { x1: number; z1: number; x2: number; z2: number } | null) => void;
  onCameraChange: (scale: number, cx: number, cz: number) => void;
  onCursorMove?: (bx: number, bz: number) => void;
}

export class MapView {
  app: Application;
  world = new Container();       // масштабируемый мир
  tileLayer = new Container();   // подложка Bluemap
  pointsLayer = new Container();
  selGraphics = new Graphics();
  cam = { cx: 0, cz: 0, scale: 4 }; // центр в блоках, px на блок

  private pointsSprite: Sprite | null = null;
  private pointsOrigin = { x: 0, z: 0 };
  private gridIndex = new Map<string, number[]>();
  private events: CpEvent[] = [];
  private mode: 'events' | 'aggregate' = 'events';
  private ctx: ColorContext = { mode: 'user', mix: 0.25, tMin: 0, tMax: 1 };
  private cb: MapCallbacks;
  private dragBtn = -1;
  private dragStart = { x: 0, y: 0, cx: 0, cz: 0 };
  private selStart: { x: number; z: number } | null = null;
  private hoverKey = '';

  ready: Promise<void>;

  constructor(container: HTMLElement, cb: MapCallbacks) {
    this.cb = cb;
    this.app = new Application();
    this.ready = this.app.init({ background: '#0b0e14', antialias: false,
      resizeTo: container, preference: 'webgl' }).then(() => {
      container.appendChild(this.app.canvas);
      this.app.stage.addChild(this.world);
      this.world.addChild(this.tileLayer);
      this.world.addChild(this.pointsLayer);
      this.app.stage.addChild(this.selGraphics);
      this.bindInput(container);
      this.app.ticker.add(() => this.updateTransform());
      this.updateTransform();
    });
  }

  private updateTransform() {
    this.world.scale.set(this.cam.scale);
    const w = this.app.renderer.width, h = this.app.renderer.height;
    this.world.position.set(w / 2 - this.cam.cx * this.cam.scale, h / 2 - this.cam.cz * this.cam.scale);
    this.cb.onCameraChange(this.cam.scale, this.cam.cx, this.cam.cz);
  }

  screenToBlock(sx: number, sy: number): [number, number] {
    const r = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    const px = sx - r.left, py = sy - r.top;
    return [
      (px - this.world.x) / this.cam.scale,
      (py - this.world.y) / this.cam.scale,
    ];
  }

  private bindInput(el: HTMLElement) {
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      this.dragBtn = e.button;
      this.dragStart = { x: e.clientX, y: e.clientY, cx: this.cam.cx, cz: this.cam.cz };
      if (e.button === 2) {
        const [bx, bz] = this.screenToBlock(e.clientX, e.clientY);
        this.selStart = { x: bx, z: bz };
      }
    });
    window.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect();
      const isInside = e.clientX >= r.left && e.clientX <= r.right &&
                       e.clientY >= r.top && e.clientY <= r.bottom;

      const [bx, bz] = this.screenToBlock(e.clientX, e.clientY);

      if (isInside && this.cb.onCursorMove) {
        this.cb.onCursorMove(bx, bz);
      } else if (!isInside && this.cb.onCursorMove) {
        this.cb.onCursorMove(NaN, NaN);
      }

      if (this.dragBtn === 0) {
        this.cam.cx = this.dragStart.cx - (e.clientX - this.dragStart.x) / this.cam.scale;
        this.cam.cz = this.dragStart.cz - (e.clientY - this.dragStart.y) / this.cam.scale;
      } else if (this.dragBtn === 2 && this.selStart) {
        this.drawSelection(bx, bz);
      } else if (this.dragBtn === -1 && isInside) {
        this.handleHover(e.clientX, e.clientY);
      }
    });
    window.addEventListener('pointerup', e => {
      if (this.dragBtn === 2 && this.selStart) {
        const [bx, bz] = this.screenToBlock(e.clientX, e.clientY);
        const s = this.selStart;
        const bbox = {
          x1: Math.min(s.x, bx), x2: Math.max(s.x, bx),
          z1: Math.min(s.z, bz), z2: Math.max(s.z, bz),
        };
        const area = Math.abs(bbox.x2 - bbox.x1) * Math.abs(bbox.z2 - bbox.z1);
        this.selStart = null;
        this.selGraphics.clear();
        this.dragBtn = -1;
        this.cb.onSelection(area > 4 ? bbox : null); // клик ПКМ без выделения — сброс
      } else if (this.dragBtn === 0) {
        const moved = Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y);
        this.dragBtn = -1;
        if (moved < 4) this.handleClick(e.clientX, e.clientY);
      } else {
        this.dragBtn = -1;
      }
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      // Запоминаем блок под курсором ДО изменения масштаба
      const [bx, bz] = this.screenToBlock(e.clientX, e.clientY);
      const k = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.cam.scale * k));
      // После изменения scale смещаем камеру так, чтобы bx/bz остался
      // под курсором: cam = bx + (cam_old - bx) / k
      this.cam.cx = bx + (this.cam.cx - bx) / k;
      this.cam.cz = bz + (this.cam.cz - bz) / k;
    }, { passive: false });
  }

  private drawSelection(bx: number, bz: number) {
    const s = this.selStart!;
    const x1 = Math.min(s.x, bx), x2 = Math.max(s.x, bx);
    const z1 = Math.min(s.z, bz), z2 = Math.max(s.z, bz);
    this.selGraphics.clear()
      .rect(x1, z1, x2 - x1, z2 - z1)
      .fill({ color: 0x4fc3f7, alpha: 0.12 })
      .stroke({ color: 0x4fc3f7, width: 1 / this.cam.scale });
  }

  // --- Рендер событий (детальный режим): 1px текстуры = 1 блок ---
  setEvents(events: CpEvent[], ctx: ColorContext) {
    this.mode = 'events';
    this.events = events;
    this.ctx = ctx;
    this.gridIndex.clear();
    if (!events.length) { this.clearPoints(); return; }
    let x1 = Infinity, x2 = -Infinity, z1 = Infinity, z2 = -Infinity;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.x < x1) x1 = e.x; if (e.x > x2) x2 = e.x;
      if (e.z < z1) z1 = e.z; if (e.z > z2) z2 = e.z;
      const k = `${e.x},${e.z}`;
      const arr = this.gridIndex.get(k);
      if (arr) arr.push(i); else this.gridIndex.set(k, [i]);
    }
    const w = Math.min(x2 - x1 + 1, 16384), h = Math.min(z2 - z1 + 1, 16384);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c2d = cv.getContext('2d')!;
    const img = c2d.createImageData(w, h);
    const data = img.data;
    // смешивание при наложении: события новее — больший вес
    const acc = new Map<number, [number, number, number, number]>(); // idx -> r,g,b,weight
    for (const e of events) {
      const px = e.x - x1, py = e.z - z1;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const [r, g, b] = eventColor(e, ctx);
      const wgt = 0.4 + 0.6 * (e.time - ctx.tMin) / Math.max(1, ctx.tMax - ctx.tMin);
      const i = py * w + px;
      const cur = acc.get(i);
      if (cur) {
        const tw = cur[3] + wgt;
        cur[0] = (cur[0] * cur[3] + r * wgt) / tw;
        cur[1] = (cur[1] * cur[3] + g * wgt) / tw;
        cur[2] = (cur[2] * cur[3] + b * wgt) / tw;
        cur[3] = tw;
      } else acc.set(i, [r, g, b, wgt]);
    }
    for (const [i, [r, g, b]] of acc) {
      const o = i * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 235;
    }
    c2d.putImageData(img, 0, 0);
    this.uploadTexture(cv, x1, z1);
  }

  // --- Рендер агрегатов (обзор): 1 чанк = 16x16 блоков ---
  setChunks(chunks: Chunk[], ctx: ColorContext) {
    this.mode = 'aggregate';
    this.events = [];
    this.gridIndex.clear();
    if (!chunks.length) { this.clearPoints(); return; }
    let x1 = Infinity, x2 = -Infinity, z1 = Infinity, z2 = -Infinity;
    for (const c of chunks) {
      const ax = c.cx * 16, az = c.cz * 16;
      if (ax < x1) x1 = ax; if (ax + 15 > x2) x2 = ax + 15;
      if (az < z1) z1 = az; if (az + 15 > z2) z2 = az + 15;
    }
    const w = Math.min(x2 - x1 + 1, 16384), h = Math.min(z2 - z1 + 1, 16384);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c2d = cv.getContext('2d')!;
    c2d.clearRect(0, 0, w, h);
    const maxCnt = Math.max(...chunks.map(c => c.cnt));
    for (const c of chunks) {
      let color: [number, number, number];
      const d = c.dominant;
      if (ctx.mode === 'action' && d) color = actionColor(d.src, d.action);
      else if (d) color = uuidColor(d.uuid, d.nick);
      else color = [120, 120, 120];
      // вторичное измерение — подмес (упрощённо: яркость по плотности)
      const density = Math.sqrt(c.cnt / maxCnt);
      const rgb = `rgb(${Math.round(color[0] * (0.5 + density * 0.5))},${Math.round(color[1] * (0.5 + density * 0.5))},${Math.round(color[2] * (0.5 + density * 0.5))})`;
      c2d.fillStyle = rgb;
      c2d.fillRect(c.cx * 16 - x1, c.cz * 16 - z1, 16, 16);
    }
    this.uploadTexture(cv, x1, z1);
  }

  private uploadTexture(cv: HTMLCanvasElement, x1: number, z1: number) {
    this.clearPoints();
    const tex = Texture.from(cv);
    tex.source.scaleMode = 'nearest';
    const sp = new Sprite(tex);
    sp.position.set(x1, z1);
    this.pointsOrigin = { x: x1, z: z1 };
    this.pointsLayer.addChild(sp);
    this.pointsSprite = sp;
  }

  private clearPoints() {
    if (this.pointsSprite) {
      this.pointsSprite.destroy({ texture: true, textureSource: true });
      this.pointsSprite = null;
    }
    this.pointsLayer.removeChildren();
  }

  private blockEvents(bx: number, bz: number): CpEvent[] {
    const idxs = this.gridIndex.get(`${Math.floor(bx)},${Math.floor(bz)}`);
    return idxs ? idxs.map(i => this.events[i]) : [];
  }

  private handleHover(sx: number, sy: number) {
    if (!this.gridIndex.size) { if (this.hoverKey) { this.hoverKey = ''; this.cb.onHover(null, sx, sy); } return; }
    const [bx, bz] = this.screenToBlock(sx, sy);
    const key = `${Math.floor(bx)},${Math.floor(bz)}`;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.cb.onHover(this.blockEvents(bx, bz), sx, sy);
  }

  private handleClick(sx: number, sy: number) {
    const [bx, bz] = this.screenToBlock(sx, sy);
    this.cb.onClick(this.blockEvents(bx, bz));
  }

  fitTo(x1: number, z1: number, x2: number, z2: number) {
    this.cam.cx = (x1 + x2) / 2;
    this.cam.cz = (z1 + z2) / 2;
    const w = this.app.renderer.width, h = this.app.renderer.height;
    this.cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(w / (x2 - x1 + 8), h / (z2 - z1 + 8))));
    this.updateTransform();
  }

  getMode() { return this.mode; }
}
