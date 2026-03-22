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
