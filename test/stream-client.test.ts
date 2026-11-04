import { describe, expect, test } from 'bun:test';

import { FilterStreamClient } from '../src/web/stream-client.ts';

class FakeEventSource {
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, data?: unknown) {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener({
        data: data === undefined ? undefined : JSON.stringify(data),
      } as MessageEvent);
    }
  }

  close() {
    this.closed = true;
  }
}

describe('FilterStreamClient', () => {
  test('ignores all late events from a paused or replaced connection', () => {
    const sources: FakeEventSource[] = [];
    const events: string[] = [];
    const client = new FilterStreamClient(url => { const source = new FakeEventSource(url); sources.push(source); return source; });
    const handlers = {
      onOpen: () => events.push('open'), onError: () => events.push('error'), onPost: () => events.push('post'),
      onAuthor: () => events.push('author'), onStats: () => events.push('stats'), onSummary: () => events.push('summary'),
      onBigrams: () => events.push('bigrams'), onSystem: () => events.push('system'),
    };
    const sendAll = (source: FakeEventSource) => {
      for (const type of ['open', 'error', 'post', 'author', 'stats', 'summary', 'bigrams', 'system']) source.emit(type, {});
    };
    client.connect([], handlers);
    client.connect(['cats'], handlers);
    sendAll(sources[0]!);
    expect(events).toEqual([]);
    sendAll(sources[1]!);
    expect(events).toHaveLength(8);
    client.disconnect();
    sendAll(sources[1]!);
    expect(events).toHaveLength(8);
  });

  test('delivers author updates and ignores them from a replaced connection', () => {
    const sources: FakeEventSource[] = [];
    const updates: unknown[] = [];
    const client = new FilterStreamClient(url => {
      const source = new FakeEventSource(url); sources.push(source); return source;
    });
    const handlers = {
      onOpen() {}, onError() {}, onPost() {}, onStats() {}, onSummary() {}, onBigrams() {}, onSystem() {},
      onAuthor: (author: unknown) => updates.push(author),
    };
    const author = { source: 'bluesky', authorId: 'did:plc:author', username: 'author.bsky.social' };
    client.connect(['cats'], handlers);
    sources[0]!.emit('author', author);
    expect(updates).toEqual([author]);
    client.connect(['dogs'], handlers);
    sources[0]!.emit('author', author);
    expect(updates).toHaveLength(1);
    sources[1]!.emit('author', author);
    expect(updates).toHaveLength(2);
    client.disconnect();
    sources[1]!.emit('author', author);
    expect(updates).toHaveLength(2);
  });

  test('includes both sources when connecting with shared filters', () => {
    let requestedUrl = '';
    const client = new FilterStreamClient(url => { requestedUrl = url; return new FakeEventSource(url); });
    client.connect(['cats', 'dogs'], {
      onOpen() {}, onError() {}, onPost() {}, onStats() {}, onSummary() {}, onBigrams() {}, onSystem() {},
    }, ['bluesky', 'x']);
    expect(requestedUrl).toBe('/events?filter=cats&filter=dogs&source=bluesky&source=x');
    client.disconnect();
  });
  test('drops the previous connection when a new filter is used', () => {
    const sources: FakeEventSource[] = [];
    const client = new FilterStreamClient((url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    });

    client.connect(['oscars'], {
      onOpen() {},
      onError() {},
      onPost() {},
      onStats() {},
      onSummary() {},
      onBigrams() {},
      onSystem() {},
    });
    client.connect(['movies', 'awards'], {
      onOpen() {},
      onError() {},
      onPost() {},
      onStats() {},
      onSummary() {},
      onBigrams() {},
      onSystem() {},
    });

    expect(sources[0]!.closed).toBe(true);
    expect(sources[1]!.url).toBe('/events?filter=movies&filter=awards');
  });
});
