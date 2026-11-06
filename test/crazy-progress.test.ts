import { describe, expect, test } from 'bun:test';
import { CrazyProgress } from '../src/web/crazy-progress.ts';

function setup(onComplete = () => {}) {
  const properties = new Map<string, string>();
  const container = {
    hidden: false, dataset: {} as Record<string, string>,
    style: { setProperty: (name: string, value: string) => { properties.set(name, value); } },
  };
  const bar = { max: 0, value: 0 };
  const progress = new CrazyProgress(container as unknown as HTMLElement, bar as HTMLProgressElement, onComplete);
  return { container, bar, progress, properties };
}

describe('Crazy mode post progress', () => {
  test('fills successive bars with 1, 2, 4, 8, and 16 incoming posts', () => {
    const { progress, bar } = setup();
    progress.setEnabled(true);
    for (const target of [1, 2, 4, 8, 16]) {
      for (let post = 1; post <= target; post++) {
        progress.notePost();
        expect(bar).toEqual({ max: target, value: post });
      }
    }
  });

  test('signals each completed bar once, never for partial progress, reset, or disabled posts', () => {
    let completions = 0;
    const { progress } = setup(() => { completions++; });
    progress.notePost();
    expect(completions).toBe(0);
    progress.setEnabled(true);
    for (const [index, target] of [1, 2, 4, 8, 16].entries()) {
      for (let post = 1; post < target; post++) {
        progress.notePost();
        expect(completions).toBe(index);
      }
      progress.notePost();
      expect(completions).toBe(index + 1);
      progress.setEnabled(true);
      expect(completions).toBe(index + 1);
    }
    progress.reset();
    progress.setEnabled(false);
    progress.notePost();
    expect(completions).toBe(5);
    progress.setEnabled(true);
    progress.notePost();
    expect(completions).toBe(6);
  });

  test('starts after 25%, accelerates gently then sharply, and stops on rollover or reset', () => {
    const { progress, container, bar, properties } = setup();
    const frequency = () => 1_000 / parseFloat(properties.get('--shake-duration')!);
    const distance = () => parseFloat(properties.get('--shake-distance')!);
    expect(container.dataset.shaking).toBe('false');
    progress.setEnabled(true);
    // Complete the first four bars, then reach 4/16 (25%).
    for (let post = 0; post < 1 + 2 + 4 + 8 + 4; post++) progress.notePost();
    expect(bar).toEqual({ max: 16, value: 4 });
    expect(container.dataset.shaking).toBe('false');
    const quarterRate = frequency();
    progress.notePost();
    expect(container.dataset.shaking).toBe('true');
    for (let post = 0; post < 3; post++) progress.notePost();
    const halfwayRate = frequency();
    const halfwayDistance = distance();
    for (let post = 0; post < 4; post++) progress.notePost();
    const threeQuarterRate = frequency();
    expect(threeQuarterRate).toBeGreaterThan(halfwayRate);
    for (let post = 0; post < 4; post++) progress.notePost();
    expect(bar).toEqual({ max: 16, value: 16 });
    expect(frequency() - threeQuarterRate).toBeGreaterThan(3 * (halfwayRate - quarterRate));
    expect(frequency()).toBeCloseTo(12);
    expect(distance()).toBeGreaterThan(halfwayDistance);
    expect(container.dataset.shaking).toBe('true');
    progress.notePost();
    expect(bar).toEqual({ max: 32, value: 1 });
    expect(container.dataset.shaking).toBe('false');
    progress.reset();
    progress.notePost();
    expect(container.dataset.shaking).toBe('true');
    progress.reset();
    expect(container.dataset.shaking).toBe('false');
    progress.notePost();
    progress.setEnabled(false);
    expect(container.dataset.shaking).toBe('false');
  });

  test('only counts in Crazy mode and starts fresh when enabled again', () => {
    const { progress, container, bar } = setup();
    expect(container.hidden).toBe(true);
    progress.notePost();
    expect(bar.value).toBe(0);
    progress.setEnabled(true);
    expect(container.hidden).toBe(false);
    progress.notePost();
    progress.setEnabled(true); // Changing Sound must not reset progress.
    expect(bar.value).toBe(1);
    progress.setEnabled(false);
    progress.notePost();
    progress.setEnabled(true);
    expect(bar).toEqual({ max: 1, value: 0 });
  });

  test('clearing the application resets the target while preserving visibility', () => {
    const { progress, container, bar } = setup();
    progress.setEnabled(true);
    for (let post = 0; post < 2; post++) progress.notePost();
    expect(bar).toEqual({ max: 2, value: 1 });
    progress.reset();
    expect(bar).toEqual({ max: 1, value: 0 });
    expect(container.hidden).toBe(false);
  });
});
