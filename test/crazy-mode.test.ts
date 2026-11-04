import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { CrazyMode } from '../src/web/crazy-mode.ts';

class Element {
  className = 'post-card';
  inert = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  parent: Element | null = null;
  constructor(public textContent = '') {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(child: Element) { this.children.push(child); child.parent = this; }
  cloneNode() { const clone = new Element(this.textContent); clone.className = this.className; return clone; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});
function setup(preferredPostId: () => string | undefined = () => undefined) {
  const timers = new Map<number, { callback: () => void; delay: number; repeat: boolean }>();
  let nextId = 0;
  for (const name of ['setInterval', 'setTimeout'] as const) {
    const spy = spyOn(globalThis, name).mockImplementation(((callback: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { callback, delay, repeat: name === 'setInterval' });
      return id;
    }) as typeof setInterval);
    restores.push(() => spy.mockRestore());
  }
  for (const name of ['clearInterval', 'clearTimeout'] as const) {
    const spy = spyOn(globalThis, name).mockImplementation(((id: number) => { timers.delete(id); }) as typeof clearInterval);
    restores.push(() => spy.mockRestore());
  }
  const body = new Element(), posts = new Element();
  const document = { body, hidden: false, createElement: () => new Element() };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let streaming = true;
  let sounds = 0;
  const mode = new CrazyMode(posts as unknown as HTMLElement, () => streaming, () => { sounds++; }, preferredPostId);
  return { mode, body, posts, timers, document, sounds: () => sounds, pause: () => { streaming = false; } };
}

describe('Crazy mode spotlight', () => {
  test('spotlights a copy of a random post every 15 seconds and removes it after three', () => {
    const f = setup();
    const original = new Element('A post with its theme styling');
    f.posts.append(original);
    f.mode.setEnabled(true);
    const interval = [...f.timers.values()][0]!;
    expect(interval.delay).toBe(15_000);
    expect(f.body.children).toHaveLength(0);
    interval.callback();
    const overlay = f.body.children[0]!;
    expect(overlay.className).toBe('crazy-overlay');
    expect(f.sounds()).toBe(1);
    expect(overlay.inert).toBe(false);
    expect(overlay.attributes.get('aria-hidden')).toBeUndefined();
    expect(overlay.children[0]!.textContent).toBe(original.textContent);
    expect(overlay.children[0]!.className).toBe('post-card');
    expect(overlay.children[0]).not.toBe(original);
    expect(f.posts.children).toEqual([original]);
    const fade = [...f.timers.values()].find(timer => !timer.repeat)!;
    expect(fade.delay).toBe(3_000);
    fade.callback();
    expect(f.body.children).toHaveLength(0);
    expect(f.timers.size).toBe(1);
    interval.callback();
    expect(f.body.children).toHaveLength(1);
    f.mode.setEnabled(false);
    expect(f.body.children).toHaveLength(0);
    expect(f.timers.size).toBe(0);
  });

  test('uses a new selected ID once, then falls back to random until a different selection arrives', () => {
    let selected: string | undefined = 'odd';
    const f = setup(() => selected);
    const normal = new Element('normal'), odd = new Element('odd'), next = new Element('next');
    normal.dataset.postId = 'normal'; odd.dataset.postId = 'odd'; next.dataset.postId = 'next';
    f.posts.append(normal); f.posts.append(odd); f.posts.append(next);
    const random = spyOn(Math, 'random').mockReturnValue(0);
    restores.push(() => random.mockRestore());
    f.mode.setEnabled(true);
    const tick = [...f.timers.values()][0]!.callback;
    const shown = () => f.body.children[0]!.children[0]!.textContent;
    tick(); expect(shown()).toBe('odd');
    tick(); expect(shown()).toBe('normal');
    selected = 'next'; tick(); expect(shown()).toBe('next');
    selected = 'evicted-post'; tick(); expect(shown()).toBe('normal');
    selected = undefined; tick(); expect(shown()).toBe('normal');
  });

  test('skips empty, paused, and hidden streams and never stacks overlays or intervals', () => {
    const f = setup();
    f.mode.setEnabled(true);
    f.mode.setEnabled(true);
    expect(f.timers.size).toBe(1);
    const interval = [...f.timers.values()][0]!;
    interval.callback();
    expect(f.body.children).toHaveLength(0);
    f.posts.append(new Element('hello'));
    f.document.hidden = true;
    interval.callback();
    expect(f.body.children).toHaveLength(0);
    f.document.hidden = false;
    interval.callback(); interval.callback();
    expect(f.body.children).toHaveLength(1);
    expect(f.timers.size).toBe(2);
    f.mode.clearOverlay();
    f.pause(); interval.callback();
    expect(f.body.children).toHaveLength(0);
  });
});
