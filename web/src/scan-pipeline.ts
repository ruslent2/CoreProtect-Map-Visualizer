/**
 * DOM-free state seam for the explicitly user-started CoreProtect scan.
 * UI/map events may mark a draft dirty, but only `start` creates a pipeline.
 */
export class ManualScanOrchestrator {
  private generation = 0;
  private activeGeneration: number | null = null;
  dirty = false;
  stopped = false;

  markDirty(): void {
    this.dirty = true;
  }

  start(): number {
    this.generation += 1;
    this.activeGeneration = this.generation;
    this.dirty = false;
    this.stopped = false;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.activeGeneration === generation && !this.stopped;
  }

  stop(generation: number): boolean {
    if (this.activeGeneration !== generation) return false;
    this.stopped = true;
    return true;
  }
}

/** Fixed-at-Apply detail queue. A request can be promoted, never duplicated. */
export class DetailTileQueue {
  private pending: string[];
  private readonly known: Set<string>;
  private readonly running = new Set<string>();
  private readonly loaded = new Set<string>();

  constructor(keys: Iterable<string>) {
    this.pending = [];
    this.known = new Set();
    for (const key of keys) {
      if (!this.known.has(key)) {
        this.known.add(key);
        this.pending.push(key);
      }
    }
  }

  take(): string | null {
    const key = this.pending.shift() ?? null;
    if (key) this.running.add(key);
    return key;
  }

  /** Reserves one requested tile without taking the next mass-queue item. */
  takeSpecific(key: string): boolean {
    if (!this.known.has(key) || this.running.has(key) || this.loaded.has(key)) return false;
    const index = this.pending.indexOf(key);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.running.add(key);
    return true;
  }

  complete(key: string, loaded: boolean): void {
    this.running.delete(key);
    if (loaded) this.loaded.add(key);
  }

  prioritize(key: string): boolean {
    if (!this.known.has(key) || this.running.has(key) || this.loaded.has(key)) return false;
    const index = this.pending.indexOf(key);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.pending.unshift(key);
    return true;
  }

  get size(): number { return this.pending.length; }
  get loadedCount(): number { return this.loaded.size; }
}

/**
 * Lifecycle gate for the fixed queue created after an aggregate commit. Mass
 * workers can only be started explicitly; a paused aggregate click reserves
 * exactly one tile and never turns into a mass start.
 */
export class DetailQueueSession {
  private massStarted = false;
  private stopped = false;

  constructor(readonly queue: DetailTileQueue, readonly workerCap: number, _pauseInitially = true) {}

  get isPaused(): boolean { return !this.stopped && !this.massStarted && this.queue.size > 0; }
  get isStopped(): boolean { return this.stopped; }
  get hasStarted(): boolean { return this.massStarted; }
  get loadedCount(): number { return this.queue.loadedCount; }

  /** The sole gate that enables draining the remaining mass queue. */
  startMass(): boolean {
    if (this.stopped || this.massStarted || this.queue.size === 0) return false;
    this.massStarted = true;
    return true;
  }

  /** Returns `started` only when this click reserved a previously pending tile. */
  startSingle(key: string): 'started' | 'prioritized' | 'unavailable' {
    if (this.stopped) return 'unavailable';
    if (this.massStarted) return this.queue.prioritize(key) ? 'prioritized' : 'unavailable';
    return this.queue.takeSpecific(key) ? 'started' : 'unavailable';
  }

  takeMass(): string | null {
    return this.massStarted && !this.stopped ? this.queue.take() : null;
  }

  stop(): void {
    this.stopped = true;
  }
}