import { Container, Sprite, Texture } from 'pixi.js';

// Локальна підкладка з PNG-експорту Xaero's World Map / Minimap. Файл не має
// прив'язки до світових координат, тому X/Z лівого верхнього кута задає користувач.
// Зображення лишається тільки в пам'яті вкладки; на сервер нічого не надсилається.

/** Max side of one sprite piece: stays under common WebGL texture limits. */
const PIECE_SIZE = 4096;

export interface XaeroPlacement {
  /** Block X of the image's top-left corner. */
  x: number;
  /** Block Z of the image's top-left corner. */
  z: number;
  /** Image pixels per block (Xaero exports are normally 1). */
  pxPerBlock: number;
}

export const DEFAULT_XAERO_PLACEMENT: XaeroPlacement = { x: 0, z: 0, pxPerBlock: 1 };

/** Replaces non-finite or non-positive input so a half-typed field never breaks the layer. */
export function normalizeXaeroPlacement(p: Partial<XaeroPlacement>): XaeroPlacement {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const scale = num(p.pxPerBlock, 1);
  return {
    x: num(p.x, 0),
    z: num(p.z, 0),
    pxPerBlock: scale > 0 ? scale : 1,
  };
}

export class XaeroOverlayLayer {
  container = new Container();
  private bitmap: ImageBitmap | null = null;
  private placement: XaeroPlacement = { ...DEFAULT_XAERO_PLACEMENT };
  private opacity = 0.9;
  private loadId = 0;

  get hasImage() { return this.bitmap != null; }

  async load(file: Blob): Promise<{ width: number; height: number }> {
    const id = ++this.loadId;
    const bitmap = await createImageBitmap(file);
    if (id !== this.loadId) { bitmap.close(); throw new Error('superseded'); }
    this.bitmap?.close();
    this.bitmap = bitmap;
    this.rebuild();
    return { width: bitmap.width, height: bitmap.height };
  }

  clear() {
    this.loadId++;
    this.bitmap?.close();
    this.bitmap = null;
    this.destroySprites();
  }

  setPlacement(p: Partial<XaeroPlacement>) {
    this.placement = normalizeXaeroPlacement({ ...this.placement, ...p });
    this.layout();
  }

  setOpacity(alpha: number) {
    this.opacity = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0.9;
    for (const child of this.container.children) child.alpha = this.opacity;
  }

  private destroySprites() {
    for (const child of this.container.removeChildren()) {
      child.destroy({ texture: true, textureSource: true });
    }
  }

  /** Cuts the bitmap into texture-sized pieces; they are positioned in layout(). */
  private rebuild() {
    this.destroySprites();
    const bmp = this.bitmap;
    if (!bmp) return;
    for (let py = 0; py < bmp.height; py += PIECE_SIZE) {
      for (let px = 0; px < bmp.width; px += PIECE_SIZE) {
        const w = Math.min(PIECE_SIZE, bmp.width - px);
        const h = Math.min(PIECE_SIZE, bmp.height - py);
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cv.getContext('2d')!.drawImage(bmp, px, py, w, h, 0, 0, w, h);
        const tex = Texture.from(cv);
        tex.source.scaleMode = 'nearest';
        const sprite = new Sprite(tex);
        sprite.alpha = this.opacity;
        sprite.label = `${px}:${py}`;
        this.container.addChild(sprite);
      }
    }
    this.layout();
  }

  private layout() {
    const { x, z, pxPerBlock } = this.placement;
    const k = 1 / pxPerBlock;
    for (const child of this.container.children) {
      const [px, py] = child.label.split(':').map(Number);
      const sprite = child as Sprite;
      sprite.position.set(x + px * k, z + py * k);
      sprite.width = sprite.texture.width * k;
      sprite.height = sprite.texture.height * k;
    }
  }
}
