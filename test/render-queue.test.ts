import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { RenderQueue } from '../src/web/render-queue.ts';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
function setup(cost = 0, capacity = 500, commitCost = 0) {
  const timers = new Map<number, { run: () => void; delay: number }>();
  let nextId = 0, now = 0, commits = 0;
  const rendered: number[] = [];
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay: number) => {
    const id = ++nextId; timers.set(id, { run, delay }); return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { timers.delete(id); }) as typeof clearTimeout);
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  restores.push(() => timeout.mockRestore(), () => clear.mockRestore(), () => clock.mockRestore());
  const queue = new RenderQueue<number>(item => { rendered.push(item); now += cost; }, () => { commits++; now += commitCost; }, capacity);
  return {
    queue, rendered, timers, commits: () => commits,
    runNext() {
      const [id, timer] = [...timers.entries()][0]!;
      timers.delete(id); now += timer.delay; timer.run();
    },
  };
}

describe('responsive feed rendering', () => {
  test('a thousand-post burst yields between batches and keeps only the newest 500 items', () => {
    const f = setup();
    for (let i = 0; i < 1_000; i++) f.queue.enqueue(i);
    expect(f.rendered).toHaveLength(0);
    expect(f.timers.size).toBe(1);
    expect([...f.timers.values()][0]!.delay).toBe(100);
    f.runNext();
    expect(f.rendered).toEqual(Array.from({ length: 20 }, (_, i) => 500 + i));
    expect(f.commits()).toBe(1);
    expect(f.timers.size).toBe(1); // Input gets a chance before the next batch.
    while (f.timers.size) f.runNext();
    expect(f.rendered).toEqual(Array.from({ length: 500 }, (_, i) => 500 + i));
    expect(f.commits()).toBe(25);
  });

  test('slow rendering yields after the six-millisecond budget', () => {
    const f = setup(2);
    for (let i = 0; i < 20; i++) f.queue.enqueue(i);
    f.runNext();
    expect(f.rendered).toEqual([0, 1, 2]);
    expect(f.commits()).toBe(1);
    expect(f.timers.size).toBe(1);
    f.runNext();
    expect(f.rendered).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('pause or filter changes cancel the backlog immediately without rendering stale items', () => {
    const f = setup();
    for (let i = 0; i < 100; i++) f.queue.enqueue(i);
    f.runNext();
    f.queue.clear();
    expect(f.timers.size).toBe(0);
    f.queue.enqueue(1_000);
    f.runNext();
    expect(f.rendered.at(-1)).toBe(1_000);
    expect(f.rendered).toHaveLength(21);
    expect(f.timers.size).toBe(0);
  });

  test('touch gestures defer rendering while incoming bursts stay bounded', () => {
    const f = setup();
    f.queue.enqueue(0);
    f.queue.defer(200);
    for (let i = 1; i <= 1_000; i++) f.queue.enqueue(i);
    expect(f.timers.size).toBe(1);
    expect([...f.timers.values()][0]!.delay).toBe(200);
    expect(f.rendered).toEqual([]);
    f.runNext();
    expect(f.rendered).toEqual(Array.from({ length: 20 }, (_, i) => 501 + i));
    expect([...f.timers.values()][0]!.delay).toBe(100);
    f.queue.clear();
    expect(f.timers.size).toBe(0);
  });

  test('expensive DOM commits reduce subsequent batches even when building posts is cheap', () => {
    const f = setup(0, 500, 30);
    for (let i = 0; i < 100; i++) f.queue.enqueue(i);
    f.runNext();
    expect(f.rendered).toHaveLength(20);
    f.runNext();
    expect(f.rendered).toHaveLength(24);
    f.runNext();
    expect(f.rendered).toHaveLength(25);
  });

});
