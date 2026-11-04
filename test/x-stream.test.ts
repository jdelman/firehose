import { describe, expect, test } from 'bun:test';
import { XStreamManager, normalizeXPost, xRuleValue } from '../src/server/sources/x-stream.ts';
import type { GenericPost } from '../src/server/models/post.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for stream state');
}

function fakeX(status = 200) {
  let rules = [{ id: 'other', value: 'unrelated', tag: 'another-app' }, { id: 'stale', value: 'stale', tag: 'firehose:old' }];
  let connections = 0;
  let active = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/rules')) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.delete) rules = rules.filter(rule => !body.delete.ids.includes(rule.id));
      if (body?.add) rules.push(...body.add.map((rule: { value: string; tag: string }) => ({ ...rule, id: rule.tag })));
      return Response.json({ data: rules });
    }
    connections++;
    if (status !== 200) return new Response(null, { status });
    active++;
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        init?.signal?.addEventListener('abort', () => { active--; c.close(); }, { once: true });
      },
    }));
  }) as typeof fetch;
  return {
    fetcher, rules: () => rules, connections: () => connections, active: () => active,
    send: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => { active--; controller.close(); },
  };
}

describe('X streaming', () => {
  test('quotes literal filters and maps expanded posts and images', () => {
    expect(xRuleValue('machine learning')).toBe('"machine learning" lang:en -is:retweet');
    expect(() => xRuleValue('cat" OR dog')).toThrow();
    expect(() => xRuleValue('a'.repeat(1024))).toThrow();
    const post = normalizeXPost({
      data: { id: '42', text: 'short', note_tweet: { text: 'full post' }, author_id: '7', attachments: { media_keys: ['m'] } },
      includes: { users: [{ id: '7', username: 'tester' }], media: [{ media_key: 'm', type: 'photo', url: 'https://example.com/photo.jpg' }] },
    });
    expect(post?.text).toBe('full post');
    expect(post?.profileUrl).toBe('https://x.com/tester');
    expect(post?.images).toHaveLength(1);
  });

  test('shares one connection, routes fragmented JSON, updates rules and cleans up only owned rules', async () => {
    const api = fakeX();
    const manager = new XStreamManager({ token: 'test-only', fetcher: api.fetcher });
    const postsA: GenericPost[] = [], postsB: GenericPost[] = [];
    const first = manager.source({ channelKey: 'a', filterTexts: ['cats'], callbacks: { onPost: post => postsA.push(post), onSystemMessage() {} } });
    const second = manager.source({ channelKey: 'b', filterTexts: ['dogs'], callbacks: { onPost: post => postsB.push(post), onSystemMessage() {} } });
    try {
      first.start(); second.start();
      await until(() => api.connections() === 1);
      expect(api.rules().some(rule => rule.id === 'stale')).toBe(false);
      const payload = JSON.stringify({ data: { id: '1', text: 'cats and dogs', lang: 'en' } });
      api.send('\r\n' + payload.slice(0, 20)); api.send(payload.slice(20) + '\r\n' + payload + '\n');
      await until(() => postsB.length === 1);
      expect(postsA).toHaveLength(1);
      expect(postsA[0]?.channelKey).toBe('a');
      expect(postsB[0]?.channelKey).toBe('b');
      await first.stop();
      await until(() => !api.rules().some(rule => rule.value.includes('cats')));
      expect(api.connections()).toBe(1);
      api.send(JSON.stringify({ data: { id: '2', text: 'cats', lang: 'en' } }) + '\n');
      await Bun.sleep(20);
      expect(postsB).toHaveLength(1);
      await second.stop();
      await until(() => api.active() === 0 && api.rules().length === 1);
      expect(api.rules()[0]?.id).toBe('other');
    } finally { await manager.close(); }
  });

  test('does not call X without credentials or filters', async () => {
    const api = fakeX();
    const messages: string[] = [];
    for (const config of [{ token: '', filterTexts: ['cats'] }, { token: 'test-only', filterTexts: [] }]) {
      const manager = new XStreamManager({ token: config.token, fetcher: api.fetcher });
      manager.source({ channelKey: 'a', filterTexts: config.filterTexts, callbacks: { onPost() {}, onSystemMessage: message => messages.push(message) } }).start();
    }
    await Bun.sleep(350);
    expect(api.connections()).toBe(0);
    expect(messages.some(message => message.includes('X_BEARER_TOKEN'))).toBe(true);
    expect(messages.some(message => message.includes('at least one filter'))).toBe(true);
  });

  test('reconnects after a dropped connection and reports state to new subscribers', async () => {
    const api = fakeX();
    const manager = new XStreamManager({ token: 'test-only', fetcher: api.fetcher });
    const messages: string[] = [];
    try {
      manager.source({ channelKey: 'a', filterTexts: ['cats'], callbacks: { onPost() {}, onSystemMessage() {} } }).start();
      await until(() => api.connections() === 1);
      manager.source({ channelKey: 'b', filterTexts: ['cats'], callbacks: { onPost() {}, onSystemMessage: message => messages.push(message) } }).start();
      await until(() => messages.includes('X connected.'));
      api.end();
      await until(() => api.connections() === 2);
      expect(api.active()).toBe(1);
    } finally { await manager.close(); }
  });

  test('reports authentication failure without retrying or exposing the token', async () => {
    const api = fakeX(401);
    const messages: string[] = [];
    const manager = new XStreamManager({ token: 'secret-test-token', fetcher: api.fetcher });
    try {
      manager.source({ channelKey: 'a', filterTexts: ['cats'], callbacks: { onPost() {}, onSystemMessage: message => messages.push(message) } }).start();
      await until(() => messages.some(message => message.includes('401')));
      await Bun.sleep(1100);
      expect(api.connections()).toBe(1);
      expect(messages.join(' ')).not.toContain('secret-test-token');
    } finally { await manager.close(); }
  });
});
