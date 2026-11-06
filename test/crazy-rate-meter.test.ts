import { describe, expect, test } from 'bun:test';
import { CrazyRateMeter } from '../src/web/crazy-rate-meter.ts';

function setup(random = () => 0.45) {
  const container = { hidden: true, dataset: {} as Record<string, string> };
  const attributes = new Map<string, string>();
  const gauge = { setAttribute: (key: string, value: string) => attributes.set(key, value) };
  const transforms = new Map<string, string>();
  const needle = { setAttribute: (key: string, value: string) => transforms.set(key, value) };
  const targetLabel = { textContent: '' };
  const rateLabel = { textContent: '' };
  const meter = new CrazyRateMeter(
    container as HTMLElement, gauge as unknown as SVGSVGElement, needle as unknown as SVGGElement,
    targetLabel as unknown as SVGTextElement, rateLabel as HTMLElement, random,
  );
  return { meter, container, attributes, transforms, targetLabel, rateLabel };
}

describe('Crazy mode rate meter', () => {
  test('chooses an inclusive 1–20 target once and preserves it across mode toggles', () => {
    expect(setup(() => 0).meter.target).toBe(1);
    expect(setup(() => 0.999999).meter.target).toBe(20);
    let calls = 0;
    const f = setup(() => { calls++; return 0.45; });
    expect(f.meter.target).toBe(10);
    expect(f.targetLabel.textContent).toBe('10');
    f.meter.setEnabled(true);
    expect(f.container.hidden).toBe(false);
    f.meter.setEnabled(false);
    expect(f.container.hidden).toBe(true);
    f.meter.setEnabled(true);
    f.meter.setRate(0);
    expect(calls).toBe(1);
    expect(f.meter.target).toBe(10);
  });

  test('centers the needle on target and turns green within the inclusive 5% band', () => {
    const f = setup();
    f.meter.setRate(10);
    expect(f.transforms.get('transform')).toBe('rotate(0 150 130)');
    expect(f.rateLabel.textContent).toBe('10.00 posts/sec · On target');
    for (const rate of [9.5, 10, 10.5]) {
      f.meter.setRate(rate);
      expect(f.container.dataset.onTarget).toBe('true');
    }
    for (const rate of [0, 9.499, 10.501, 20]) {
      f.meter.setRate(rate);
      expect(f.container.dataset.onTarget).toBe('false');
    }
    expect(f.rateLabel.textContent).toContain('Above target');
    f.meter.setRate(9);
    expect(f.rateLabel.textContent).toContain('Below target');
  });

  test('clamps the needle to the dial while reporting the actual rate accessibly', () => {
    const f = setup();
    expect(f.transforms.get('transform')).toBe('rotate(-75 150 130)');
    expect(f.attributes.get('aria-valuemin')).toBe('0');
    expect(f.attributes.get('aria-valuemax')).toBe('20');
    f.meter.setRate(100);
    expect(f.transforms.get('transform')).toBe('rotate(75 150 130)');
    expect(f.attributes.get('aria-valuenow')).toBe('20');
    expect(f.attributes.get('aria-valuetext')).toContain('100.00 posts per second');
    for (const rate of [-1, NaN, Infinity]) {
      f.meter.setRate(rate);
      expect(f.attributes.get('aria-valuenow')).toBe('0');
      expect(f.transforms.get('transform')).toBe('rotate(-75 150 130)');
    }
  });
});
