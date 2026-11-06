import { describe, expect, test } from 'bun:test';
import { CrazyProgress } from '../src/web/crazy-progress.ts';

function setup() {
  const container = { hidden: false };
  const bar = { max: 0, value: 0 };
  const label = { textContent: '' };
  const progress = new CrazyProgress(container as HTMLElement, bar as HTMLProgressElement, label as HTMLElement);
  return { container, bar, label, progress };
}

describe('Crazy mode post progress', () => {
  test('fills successive bars with 1, 2, 4, 8, and 16 incoming posts', () => {
    const { progress, bar, label } = setup();
    progress.setEnabled(true);
    for (const target of [1, 2, 4, 8, 16]) {
      for (let post = 1; post <= target; post++) {
        progress.notePost();
        expect(bar).toEqual({ max: target, value: post });
      }
      expect(label.textContent).toBe(`${target.toLocaleString('en-US')} / ${target.toLocaleString('en-US')} posts`);
    }
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
    const { progress, container, bar, label } = setup();
    progress.setEnabled(true);
    for (let post = 0; post < 2; post++) progress.notePost();
    expect(bar).toEqual({ max: 2, value: 1 });
    progress.reset();
    expect(bar).toEqual({ max: 1, value: 0 });
    expect(label.textContent).toBe('0 / 1 posts');
    expect(container.hidden).toBe(false);
  });
});
