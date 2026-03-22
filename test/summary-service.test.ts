import { describe, expect, test } from 'bun:test';

import { ChannelSummaryService } from '../src/server/summary-service.ts';

describe('ChannelSummaryService', () => {
  test('publishes a generated summary for buffered posts', async () => {
    const snapshots: string[] = [];
    const service = new ChannelSummaryService({
      intervalMs: 50,
      generateSummary: async (posts) => ({
        text: `Summary for ${posts.length}`,
        keywords: {
          'academy awards': ['awards', 'academy', 'oscars', 'red carpet', 'best picture'],
        },
      }),
      onUpdate: (snapshot) => {
        snapshots.push(`${snapshot.status}:${snapshot.text}`);
      },
    });

    service.start();
    service.notePost('first');
    service.notePost('second');
    await service.flush();
    service.stop();

    expect(snapshots).toContain('updating:Waiting for the first 10-second window.');
    expect(snapshots.some((item) => item === 'idle:Summary for 2')).toBe(true);
    expect(service.getSnapshot().keywords).toEqual({
      'academy awards': ['awards', 'academy', 'oscars', 'red carpet', 'best picture'],
    });
  });

  test('keeps the previous summary when a window has no posts', async () => {
    const snapshots: string[] = [];
    const service = new ChannelSummaryService({
      intervalMs: 50,
      generateSummary: async () => ({
        text: 'Fresh summary',
        keywords: {
          'fresh topic': ['fresh', 'topic', 'new angle', 'breaking', 'latest'],
        },
      }),
      onUpdate: (snapshot) => {
        snapshots.push(snapshot.text);
      },
    });

    service.start();
    service.notePost('hello');
    await service.flush();
    await service.flush();
    service.stop();

    expect(snapshots.filter((item) => item === 'Fresh summary').length).toBeGreaterThan(0);
    expect(service.getSnapshot().text).toBe('Fresh summary');
    expect(service.getSnapshot().keywords).toEqual({
      'fresh topic': ['fresh', 'topic', 'new angle', 'breaking', 'latest'],
    });
    expect(service.getSnapshot().status).toBe('idle');
  });
});
