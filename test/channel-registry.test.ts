import { describe, expect, test } from 'bun:test';

import { ChannelRegistry } from '../src/server/channel-registry.ts';
import type { GenericPost } from '../src/server/models/post.ts';
import { InMemoryPubSubAdapter } from '../src/server/pubsub/in-memory-pubsub.ts';
import type { SourceCallbacks } from '../src/server/sources/source.ts';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ChannelRegistry', () => {
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
