import { describe, expect, test } from 'bun:test';

import { ChannelBigramService } from '../src/server/bigram-service.ts';

describe('ChannelBigramService', () => {
  test('tracks the top 10 lowercased bigrams while removing stop words', () => {
    let latest = {
      items: [] as Array<{ phrase: string; count: number }>,
      updatedAt: null as string | null,
    };

    const service = new ChannelBigramService((snapshot) => {
      latest = snapshot;
    });

    service.start();
    service.notePost('The Academy Awards were amazing and the Academy Awards were loud.');
    service.notePost('Academy awards reactions are everywhere.');

    expect(latest.items[0]).toEqual({
      phrase: 'academy awards',
      count: 3,
    });
    expect(latest.items.some((item) => item.phrase.includes('the academy'))).toBe(false);
    expect(latest.updatedAt).not.toBeNull();
  });

  test('excludes hashtags, usernames, urls, and emoji from bigrams', () => {
    let latest = {
      items: [] as Array<{ phrase: string; count: number }>,
      updatedAt: null as string | null,
    };

    const service = new ChannelBigramService((snapshot) => {
      latest = snapshot;
    });

    service.start();
    service.notePost(
      'Amazing #Oscars vibes from @alice on the red carpet 😄 https://example.com/watch',
    );

    expect(latest.items.some((item) => item.phrase.includes('oscars'))).toBe(false);
    expect(latest.items.some((item) => item.phrase.includes('alice'))).toBe(false);
    expect(latest.items.some((item) => item.phrase.includes('example'))).toBe(false);
    expect(latest.items).toContainEqual({
      phrase: 'amazing vibes',
      count: 1,
    });
  });

  test('excludes bare domains and protocol fragments from bigrams', () => {
    let latest = {
      items: [] as Array<{ phrase: string; count: number }>,
      updatedAt: null as string | null,
    };

    const service = new ChannelBigramService((snapshot) => {
      latest = snapshot;
    });

    service.start();
    service.notePost(
      'Breaking: https www europesays.com says the market is moving fast',
    );

    expect(latest.items.some((item) => item.phrase.includes('https'))).toBe(false);
    expect(latest.items.some((item) => item.phrase.includes('www'))).toBe(false);
    expect(latest.items.some((item) => item.phrase.includes('europesays'))).toBe(false);
    expect(latest.items.some((item) => item.phrase.includes('com'))).toBe(false);
    expect(latest.items).toContainEqual({
      phrase: 'breaking says',
      count: 1,
    });
  });

  test('resets the bigram snapshot', () => {
    let latest = {
      items: [] as Array<{ phrase: string; count: number }>,
      updatedAt: null as string | null,
    };

    const service = new ChannelBigramService((snapshot) => {
      latest = snapshot;
    });

    service.start();
    service.notePost('academy awards reactions everywhere');
    expect(latest.items.length).toBeGreaterThan(0);

    service.reset();

    expect(latest.items).toEqual([]);
    expect(latest.updatedAt).not.toBeNull();
  });

  test('never includes a bigram where both tokens are numbers', () => {
    let latest = {
      items: [] as Array<{ phrase: string; count: number }>,
      updatedAt: null as string | null,
    };

    const service = new ChannelBigramService((snapshot) => {
      latest = snapshot;
    });

    service.start();
    service.notePost('2024 2025 iphone 16 17 pro');

    expect(latest.items.some((item) => item.phrase === '2024 2025')).toBe(false);
    expect(latest.items.some((item) => item.phrase === '16 17')).toBe(false);
    expect(latest.items.some((item) => item.phrase === 'iphone 16')).toBe(true);
  });
});
