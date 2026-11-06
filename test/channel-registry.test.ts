import { describe, expect, spyOn, test } from 'bun:test';

import { ChannelRegistry } from '../src/server/channel-registry.ts';
import type { GenericPost } from '../src/server/models/post.ts';
import { InMemoryPubSubAdapter } from '../src/server/pubsub/in-memory-pubsub.ts';
import type { SourceCallbacks } from '../src/server/sources/source.ts';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ChannelRegistry', () => {
  test('counts shared streaming clients separately from open Bluesky connections', async () => {
    let open = true;
    const registry = new ChannelRegistry({
      pubsub: new InMemoryPubSubAdapter(),
      createSource: ({ sources }) => ({
        start() {}, stop() {},
        getBlueskyConnectionCount: () => Number(open && sources.includes('bluesky')),
      }),
    });
    expect(registry.getConnections()).toEqual({ blueskyConnections: 0, connectedClients: 0 });
    const subscriptions = [
      registry.subscribe({ filterTexts: ['cats'], listener() {} }),
      registry.subscribe({ filterTexts: ['cats'], listener() {} }),
      registry.subscribe({ filterTexts: ['dogs'], sources: ['bluesky', 'x'], listener() {} }),
      registry.subscribe({ filterTexts: [], sources: ['x'], listener() {} }),
    ];
    try {
      expect(registry.getConnections()).toEqual({ blueskyConnections: 2, connectedClients: 4 });
      open = false;
      expect(registry.getConnections()).toEqual({ blueskyConnections: 0, connectedClients: 4 });
      open = true;
      await subscriptions[0]!.unsubscribe();
      expect(registry.getConnections()).toEqual({ blueskyConnections: 2, connectedClients: 3 });
    } finally {
      for (const subscription of subscriptions.slice(1)) await subscription.unsubscribe();
    }
    expect(registry.getConnections()).toEqual({ blueskyConnections: 0, connectedClients: 0 });
  });

  test('shares author updates with channel subscribers without counting them as posts', async () => {
    let callbacks!: SourceCallbacks;
    const registry = new ChannelRegistry({
      pubsub: new InMemoryPubSubAdapter(),
      createSource: config => { callbacks = config.callbacks; return { start() {}, stop() {} }; },
      summaryGenerator: async () => ({ text: 'stub', keywords: {} }),
    });
    const authorsA: unknown[] = [], authorsB: unknown[] = [];
    const first = registry.subscribe({ filterTexts: [], listener: event => { if (event.type === 'author') authorsA.push(event.data); } });
    const second = registry.subscribe({ filterTexts: [], listener: event => { if (event.type === 'author') authorsB.push(event.data); } });
    try {
      const author = { source: 'bluesky', authorId: 'did:plc:author', username: 'author.bsky.social' };
      callbacks.onAuthor!(author);
      expect(authorsA).toEqual([author]);
      expect(authorsB).toEqual([author]);
      expect(second.snapshot.stats.totalPosts).toBe(0);
    } finally { await first.unsubscribe(); await second.unsubscribe(); }
  });

  test('averages posts over five seconds and expires older posts without resetting the total', async () => {
    let now = 10_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    let callbacks!: SourceCallbacks;
    const registry = new ChannelRegistry({
      pubsub: new InMemoryPubSubAdapter(),
      createSource: config => { callbacks = config.callbacks; return { start() {}, stop() {} }; },
      summaryGenerator: async () => ({ text: 'stub', keywords: {} }),
    });
    const subscriptions: ReturnType<ChannelRegistry['subscribe']>[] = [];
    const snapshot = () => {
      const subscription = registry.subscribe({ filterTexts: [], listener() {} });
      subscriptions.push(subscription);
      return subscription.snapshot.stats;
    };
    try {
      expect(snapshot().postsPerSecond).toBe(0);
      for (let i = 0; i < 5; i++) callbacks.onPost({
        id: String(i), source: 'bluesky', channelKey: subscriptions[0]!.channelKey,
        authorId: 'author', username: 'tester', text: 'hello', createdAt: new Date().toISOString(),
      });
      now = 14_999;
      expect(snapshot()).toMatchObject({ postsPerSecond: 1, totalPosts: 5 });
      now = 15_001;
      expect(snapshot()).toMatchObject({ postsPerSecond: 0, totalPosts: 5 });
      callbacks.onPost({
        id: 'new', source: 'bluesky', channelKey: subscriptions[0]!.channelKey,
        authorId: 'author', username: 'tester', text: 'new post', createdAt: new Date().toISOString(),
      });
      expect(snapshot()).toMatchObject({ postsPerSecond: 0.2, totalPosts: 6 });
    } finally {
      clock.mockRestore();
      for (const subscription of subscriptions) await subscription.unsubscribe();
    }
  });

  test('passes source samples through to combined summaries and subscribers', async () => {
    let callbacks!: SourceCallbacks;
    let resolveComparison!: (text: string) => void;
    const comparison = new Promise<string>(resolve => { resolveComparison = resolve; });
    const registry = new ChannelRegistry({
      pubsub: new InMemoryPubSubAdapter(),
      createSource: config => { callbacks = config.callbacks; return { start() {}, stop() {} }; },
      summaryIntervalMs: 100,
      summaryGenerator: async (posts, sources) => {
        expect(posts).toEqual([
          { id: 'bluesky', text: 'Bluesky cats', source: 'bluesky' },
          { id: 'x', text: 'X cats', source: 'x' },
        ]);
        expect(sources).toEqual({ bluesky: ['Bluesky cats'], x: ['X cats'] });
        return { text: 'Cats', keywords: {}, comparison: 'Both discuss cats.', spotlightPostId: 'x' };
      },
    });
    const subscription = registry.subscribe({
      sources: ['bluesky', 'x'], filterTexts: ['cats'],
      listener: event => {
        if (event.type === 'summary' && event.data.comparison) {
          expect(event.data.spotlightPostId).toBe('x');
          resolveComparison(event.data.comparison);
        }
      },
    });
    let timeout: Timer | undefined;
    try {
      await sleep(20);
      for (const source of ['bluesky', 'x']) callbacks.onPost({
        id: source, source, channelKey: subscription.channelKey, authorId: 'author', username: 'tester',
        text: source === 'x' ? 'X cats' : 'Bluesky cats', createdAt: new Date().toISOString(),
      });
      const failure = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Comparison was not published')), 1_000); });
      expect(await Promise.race([comparison, failure])).toBe('Both discuss cats.');
    } finally {
      clearTimeout(timeout);
      await subscription.unsubscribe();
    }
  });

  test('isolates source selections and reuses equivalent combined subscriptions', async () => {
    const created: string[][] = [];
    const registry = new ChannelRegistry({
      pubsub: new InMemoryPubSubAdapter(),
      createSource: ({ sources }) => { created.push(sources); return { start() {}, stop() {} }; },
      summaryGenerator: async () => ({ text: 'stub', keywords: {} }),
    });
    const bluesky = registry.subscribe({ filterTexts: ['cats'], sources: ['bluesky'], listener() {} });
    const x = registry.subscribe({ filterTexts: ['cats'], sources: ['x'], listener() {} });
    const both = registry.subscribe({ filterTexts: ['cats'], sources: ['bluesky', 'x'], listener() {} });
    const same = registry.subscribe({ filterTexts: ['CATS'], sources: ['x', 'bluesky'], listener() {} });
    expect(created).toEqual([['bluesky'], ['x'], ['bluesky', 'x']]);
    expect(new Set([bluesky.channelKey, x.channelKey, both.channelKey]).size).toBe(3);
    expect(same.channelKey).toBe(both.channelKey);
    await Promise.all([bluesky.unsubscribe(), x.unsubscribe(), both.unsubscribe(), same.unsubscribe()]);
  });
  test('reuses a single source for duplicate filters and tears it down after the last unsubscribe', async () => {
    let sourceStarts = 0;
    let sourceStops = 0;
    const callbacksByChannel = new Map<string, SourceCallbacks>();

    const registry = new ChannelRegistry({
      pubsub: new InMemoryPubSubAdapter(),
      createSource: ({ channelKey, callbacks }) => {
        callbacksByChannel.set(channelKey, callbacks);
        return {
          start() {
            sourceStarts += 1;
          },
          stop() {
            sourceStops += 1;
          },
        };
      },
      summaryGenerator: async () => ({ text: 'stub', keywords: {} }),
      summaryIntervalMs: 1_000,
      statsIntervalMs: 1_000,
    });

    const eventsA: string[] = [];
    const eventsB: string[] = [];

    const subA = registry.subscribe({
      filterTexts: ['oscars', 'awards'],
      listener: (event) => {
        eventsA.push(event.type);
      },
    });
    const subB = registry.subscribe({
      filterTexts: ['AWARDS', 'OSCARS'],
      listener: (event) => {
        eventsB.push(event.type);
      },
    });

    expect(sourceStarts).toBe(1);
    expect(subB.channelKey).toBe('awards|oscars');

    callbacksByChannel.get('awards|oscars')!.onPost({
      id: '1',
      source: 'bluesky',
      channelKey: 'awards|oscars',
      authorId: 'did:plc:test',
      username: 'tester.bsky.social',
      text: 'Oscars post',
      createdAt: new Date().toISOString(),
    } satisfies GenericPost);

    expect(eventsA).toContain('post');
    expect(eventsB).toContain('post');

    await subA.unsubscribe();
    expect(sourceStops).toBe(0);

    await subB.unsubscribe();
    expect(sourceStops).toBe(1);
  });

  test('creates separate sources for distinct filters', async () => {
    const keys: string[] = [];

    const registry = new ChannelRegistry({
      pubsub: new InMemoryPubSubAdapter(),
      createSource: ({ channelKey }) => {
        keys.push(channelKey);
        return {
          start() {},
          stop() {},
        };
      },
      summaryGenerator: async () => ({ text: 'stub', keywords: {} }),
    });

    const first = registry.subscribe({
      filterTexts: ['oscars'],
      listener() {},
    });
    const second = registry.subscribe({
      filterTexts: ['movies'],
      listener() {},
    });

    expect(keys.sort()).toEqual(['movies', 'oscars']);

    await first.unsubscribe();
    await second.unsubscribe();
    await sleep(5);
  });
});
