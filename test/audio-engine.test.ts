import { afterEach, describe, expect, test } from 'bun:test';
import { AudioEngine } from '../src/web/audio-engine.ts';

class Param {
  values: number[] = [];
  setValueAtTime(value: number) { this.values.push(value); }
  exponentialRampToValueAtTime() {}
}
class Node {
  gain = new Param(); frequency = new Param(); Q = new Param();
  threshold = new Param(); knee = new Param(); ratio = new Param(); attack = new Param(); release = new Param();
  disconnected = false;
  connections: Node[] = [];
  ended?: () => void;
  connect(node: Node) { this.connections.push(node); }
  disconnect() { this.disconnected = true; }
  start() {}
  stop() {}
  addEventListener(_type: string, ended: () => void) { this.ended = ended; }
}
class Context {
  state = 'running'; currentTime = 0; sampleRate = 44100;
  destination = new Node();
  bufferSources: Node[] = []; decodes = 0;
  oscillators: Node[] = []; reverbs: Node[] = []; compressors: Node[] = []; nodes: Node[] = [];
  async decodeAudioData() { this.decodes++; return this.createBuffer(2, 100); }
  createBufferSource() { const node = this.node(); this.bufferSources.push(node); return node; }
  createOscillator() { const node = this.node(); this.oscillators.push(node); return node; }
  createGain() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createConvolver() { const node = this.node(); this.reverbs.push(node); return node; }
  createDynamicsCompressor() { const node = this.node(); this.compressors.push(node); return node; }
  createBuffer(channels: number, length: number) {
    return { numberOfChannels: channels, getChannelData: () => new Float32Array(length) };
  }
  async resume() { this.state = 'running'; }
  private node() { const node = new Node(); this.nodes.push(node); return node; }
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function setup() {
  const context = new Context();
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { AudioContext: class { constructor() { return context; } } },
  });
  return { context, audio: new AudioEngine() };
}

describe('audio under load', () => {
  test('preloads the spotlight clip once and reuses it through the compressed output', async () => {
    const { audio, context } = setup();
    let requests = 0;
    globalThis.fetch = (async input => {
      expect(input).toBe('/sounds/faa.m4a');
      requests++;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    await audio.primeSpotlight();
    expect(context.bufferSources).toHaveLength(0);
    await audio.playSpotlight(); await audio.playSpotlight();
    expect(requests).toBe(1);
    expect(context.decodes).toBe(1);
    expect(context.bufferSources).toHaveLength(2);
    expect(context.compressors).toHaveLength(1);
    for (const node of context.bufferSources) {
      expect(node.connections[0]!.connections[0]).toBe(context.compressors[0]);
      node.ended!();
      expect(node.disconnected).toBe(true);
      expect(node.connections[0]!.disconnected).toBe(true);
    }
  });

  test('preloads completion audio separately and plays every completion even in bursts', async () => {
    const { audio, context } = setup();
    const requests: string[] = [];
    globalThis.fetch = (async input => {
      requests.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    await Promise.all([audio.primeProgressComplete(), audio.primeSpotlight()]);
    expect(requests).toEqual(['/sounds/gunshot.m4a', '/sounds/faa.m4a']);
    expect(context.bufferSources).toHaveLength(0);
    await Promise.all(Array.from({ length: 5 }, () => audio.playProgressComplete()));
    expect(requests).toHaveLength(2);
    expect(context.decodes).toBe(2);
    expect(context.bufferSources).toHaveLength(5);
    for (const node of context.bufferSources) {
      expect(node.connections[0]!.connections[0]).toBe(context.compressors[0]);
      node.ended!();
      expect(node.disconnected).toBe(true);
      expect(node.connections[0]!.disconnected).toBe(true);
    }
  });

  test('retries unavailable completion audio without interrupting progress', async () => {
    const { audio, context } = setup();
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return attempts === 1 ? new Response(null, { status: 404 }) : new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    await audio.playProgressComplete();
    expect(context.bufferSources).toHaveLength(0);
    await audio.playProgressComplete();
    expect(attempts).toBe(2);
    expect(context.bufferSources).toHaveLength(1);
  });

  test('an unavailable spotlight clip does not break the mode', async () => {
    const { audio, context } = setup();
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    await audio.playSpotlight();
    expect(context.bufferSources).toHaveLength(0);
  });

  test('Streamserver walks up and down the scale and skips no notes in bursts', async () => {
    const { audio, context } = setup();
    for (let i = 0; i < 11; i++) {
      context.currentTime = i * 0.1;
      await audio.playClick(0, 'streamserver');
      await audio.playClick(50, 'streamserver'); // Throttled calls must not advance the melody.
    }
    expect(context.oscillators.map(node => node.frequency.values[0])).toEqual([
      523.25, 587.33, 659.25, 783.99, 880, 1046.5, 880, 783.99, 659.25, 587.33, 523.25,
    ]);
  });

  test('Streamserver transposes the melody with rate while preserving its intervals', async () => {
    const melodies: number[][] = [];
    for (const rate of [0, 4, 8, 100]) {
      const { audio, context } = setup();
      for (let i = 0; i < 11; i++) {
        context.currentTime = i * 0.1;
        await audio.playClick(rate, 'streamserver');
      }
      melodies.push(context.oscillators.map(node => node.frequency.values[0]!));
    }
    for (let i = 0; i < 11; i++) {
      expect(melodies[1]![i]! / melodies[0]![i]!).toBeCloseTo(Math.SQRT2);
      expect(melodies[2]![i]! / melodies[0]![i]!).toBeCloseTo(2);
      expect(melodies[3]![i]).toBe(melodies[2]![i]);
    }
  });

  test('coalesces a thousand-post burst into one tone without a delayed audio queue', async () => {
    const { audio, context } = setup();
    await Promise.all(Array.from({ length: 1_000 }, () => audio.playClick(100, 'streamserver')));
    expect(context.oscillators).toHaveLength(1);
    context.currentTime = 0.084;
    await audio.playClick(100, 'streamserver');
    expect(context.oscillators).toHaveLength(2);
    expect(context.reverbs).toHaveLength(1);
    expect(context.compressors).toHaveLength(1);
    expect(context.oscillators.every(node => node.connections.length > 0)).toBe(true);
  });

  test('bounds tone creation during sustained traffic, across theme changes', async () => {
    const { audio, context } = setup();
    for (let i = 0; i < 1_000; i++) {
      context.currentTime = i / 1_000;
      await audio.playClick(100, i % 2 ? 'dark' : 'light');
    }
    expect(context.oscillators).toHaveLength(12);
    expect(context.reverbs).toHaveLength(1);
    expect(context.compressors).toHaveLength(1);
    for (const oscillator of context.oscillators) oscillator.ended!();
    expect(context.oscillators.every(node => node.disconnected)).toBe(true);
    expect(context.reverbs[0]!.disconnected).toBe(false); // Shared reverb finishes its tail.
  });

  test('preserves individual sounds at normal rates and coalesces resumed bursts', async () => {
    const { audio, context } = setup();
    for (let i = 0; i < 5; i++) {
      context.currentTime = i * 0.25;
      await audio.playClick(4);
    }
    expect(context.oscillators).toHaveLength(5);
    context.currentTime = 2;
    context.state = 'suspended';
    await Promise.all(Array.from({ length: 50 }, () => audio.playClick(50)));
    expect(context.oscillators).toHaveLength(6);
  });
});
