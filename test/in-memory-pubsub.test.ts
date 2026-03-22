import { describe, expect, test } from 'bun:test';

import { InMemoryPubSubAdapter } from '../src/server/pubsub/in-memory-pubsub.ts';

describe('InMemoryPubSubAdapter', () => {
  test('publishes to all channel subscribers and unsubscribes cleanly', () => {
    const pubsub = new InMemoryPubSubAdapter();
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const unsubscribeA = pubsub.subscribe('oscars', (event) => {
      receivedA.push(event.type);
    });
    pubsub.subscribe('oscars', (event) => {
      receivedB.push(event.type);
    });

    pubsub.publish('oscars', {
      type: 'system',
      data: {
        message: 'connected',
      },
    });

    unsubscribeA();
    pubsub.publish('oscars', {
      type: 'system',
      data: {
        message: 'second',
      },
    });

    expect(receivedA).toEqual(['system']);
    expect(receivedB).toEqual(['system', 'system']);
    expect(pubsub.subscriberCount('oscars')).toBe(1);
  });
});
