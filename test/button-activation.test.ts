import { describe, expect, test } from 'bun:test';
import { bindButtonActivation } from '../src/web/button-activation.ts';

class Button extends EventTarget {
  disabled = false;
  getBoundingClientRect() { return { left: 0, right: 36, top: 0, bottom: 36 }; }
}

function setup() {
  const button = new Button();
  let activations = 0;
  bindButtonActivation(button as unknown as HTMLButtonElement, () => { activations++; });
  function send(type: string, properties: Record<string, unknown> = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 18, clientY: 18,
      ...properties,
    });
    button.dispatchEvent(event);
    return event;
  }
  return { button, send, activations: () => activations };
}

describe('mobile button activation', () => {
  test('a touch activates on release even when no compatibility click arrives', () => {
    const f = setup();
    f.send('pointerdown');
    expect(f.activations()).toBe(0);
    f.send('pointerup');
    expect(f.activations()).toBe(1);
  });

  test('a delayed Safari mouse-style click does not toggle play back on', () => {
    const f = setup();
    f.send('pointerdown');
    f.send('pointerup');
    expect(f.send('click', { detail: 1, pointerType: 'mouse' }).defaultPrevented).toBe(true);
    expect(f.activations()).toBe(1);
    // Keyboard and assistive technology activation remains available.
    f.send('click', { detail: 0 });
    expect(f.activations()).toBe(2);
    f.send('pointerdown', { pointerType: 'mouse' });
    f.send('click', { detail: 1, pointerType: 'mouse' });
    expect(f.activations()).toBe(3);
  });

  test('rapid successive taps each activate once', () => {
    const f = setup();
    for (let i = 0; i < 10; i++) {
      f.send('pointerdown');
      f.send('pointerup');
      f.send('click', { detail: 1 });
    }
    expect(f.activations()).toBe(10);
  });

  test('dragging, releasing outside, cancellation, and secondary touches do not activate', () => {
    for (const gesture of ['drag', 'outside', 'cancel', 'secondary']) {
      const f = setup();
      f.send('pointerdown', { isPrimary: gesture !== 'secondary' });
      if (gesture === 'drag') f.send('pointermove', { clientX: 35 });
      if (gesture === 'cancel') f.send('pointercancel');
      f.send('pointerup', { clientX: gesture === 'outside' ? 40 : 18 });
      expect(f.activations()).toBe(0);
    }
  });

  test('disabled buttons cannot activate', () => {
    const f = setup();
    f.send('pointerdown');
    f.button.disabled = true;
    f.send('pointerup');
    f.send('click', { detail: 0 });
    expect(f.activations()).toBe(0);
  });
});
