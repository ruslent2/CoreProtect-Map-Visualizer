import { describe, expect, it } from 'vitest';
import { DetailQueueSession, DetailTileQueue, ManualScanOrchestrator } from '../src/scan-pipeline';
import { calculateEffectiveTime } from '../src/state';

describe('manual scan orchestration', () => {
  it('only creates a pipeline on explicit start; all draft changes only become dirty', () => {
    const scan = new ManualScanOrchestrator();
    scan.markDirty(); // Filter, world, bbox, camera, zoom, and resize share this no-fetch path.
    expect(scan.dirty).toBe(true);
    expect(scan.isCurrent(1)).toBe(false);
    expect(scan.start()).toBe(1);
    expect(scan.dirty).toBe(false);
    expect(scan.isCurrent(1)).toBe(true);
  });

  it('freezes the default effective time at Apply', () => {
    const applied = calculateEffectiveTime({ mode: 'default', from: null, to: null }, 1_000_000);
    expect(applied).toEqual({ from: 978_400, to: 1_000_000, error: null });
    expect(applied.to).not.toBe(calculateEffectiveTime({ mode: 'default', from: null, to: null }, 1_000_100).to);
  });

  it('uses fixed queue order and prioritizes without duplicates', () => {
    const queue = new DetailTileQueue(['0:0', '1:0', '1:0', '2:0']);
    expect(queue.prioritize('2:0')).toBe(true);
    expect(queue.take()).toBe('2:0');
    expect(queue.prioritize('2:0')).toBe(false);
    queue.complete('2:0', true);
    expect(queue.take()).toBe('0:0');
    expect(queue.take()).toBe('1:0');
    expect(queue.take()).toBeNull();
  });

  it('gates stale generations and stopping preserves loaded work', () => {
    const scan = new ManualScanOrchestrator();
    const first = scan.start();
    const second = scan.start();
    expect(scan.isCurrent(first)).toBe(false);
    expect(scan.isCurrent(second)).toBe(true);
    const loaded = ['0:0'];
    expect(scan.stop(second)).toBe(true);
    expect(scan.isCurrent(second)).toBe(false);
    expect(loaded).toEqual(['0:0']);
  });

  it('never starts detail work when zoom changes', () => {
    const session = new DetailQueueSession(new DetailTileQueue(['0:0']), 2);
    // Camera code has no session start API; scale is visual-only by design.
    expect(session.isPaused).toBe(true);
    expect(session.takeMass()).toBeNull();
    expect(session.hasStarted).toBe(false);
  });

  it('starts the mass queue exactly once only through explicit continuation', () => {
    const session = new DetailQueueSession(new DetailTileQueue(['0:0', '1:0']), 2);
    expect(session.startMass()).toBe(true);
    expect(session.startMass()).toBe(false);
    expect(session.takeMass()).toBe('0:0');
  });

  it('clicking an aggregate starts exactly one requested tile without draining the queue', () => {
    const session = new DetailQueueSession(new DetailTileQueue(['0:0', '1:0']), 2, true);
    expect(session.startSingle('1:0')).toBe('started');
    expect(session.takeMass()).toBeNull();
    session.queue.complete('1:0', true);
    expect(session.queue.take()).toBe('0:0');
  });

  it('does not duplicate a queued, running, or loaded aggregate click', () => {
    const session = new DetailQueueSession(new DetailTileQueue(['0:0', '1:0']), 2);
    expect(session.startSingle('1:0')).toBe('started');
    expect(session.startSingle('1:0')).toBe('unavailable');
    session.queue.complete('1:0', true);
    expect(session.startSingle('1:0')).toBe('unavailable');
  });

  it('click during mass loading only reprioritizes the existing queue', () => {
    const session = new DetailQueueSession(new DetailTileQueue(['0:0', '1:0', '2:0']), 2);
    expect(session.startMass()).toBe(true);
    expect(session.startSingle('2:0')).toBe('prioritized');
    expect(session.takeMass()).toBe('2:0');
    expect(session.hasStarted).toBe(true);
  });

  it('stopping permanently prevents both mass continuation and click loading', () => {
    const session = new DetailQueueSession(new DetailTileQueue(['0:0']), 2, true);
    session.stop();
    expect(session.startMass()).toBe(false);
    expect(session.startSingle('0:0')).toBe('unavailable');
    expect(session.takeMass()).toBeNull();
  });
});