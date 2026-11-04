import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { ChannelSummaryService, generateOpenRouterSummary, type SourceSamples } from '../src/server/summary-service.ts';

describe('ChannelSummaryService', () => {
  test('groups recent posts by source and publishes the comparison', async () => {
    let samples: unknown;
    const service = new ChannelSummaryService({
      compareSources: true,
      generateSummary: async (_posts, sources) => {
        samples = sources;
        return { text: 'Cat news', keywords: {}, comparison: 'Both discuss cats; X focuses on adoption.' };
      },
      onUpdate() {},
    });
    for (let index = 0; index < 60; index++) service.notePost(`Bluesky ${index}`, 'bluesky');
    service.notePost('X adoption news', 'x');
    await service.flush();
    expect(samples).toEqual({ bluesky: Array.from({ length: 50 }, (_, index) => `Bluesky ${index + 10}`), x: ['X adoption news'] });
    expect(service.getSnapshot().comparison).toBe('Both discuss cats; X focuses on adoption.');
  });

  test('waits for both sources and excludes posts outside the recent window', async () => {
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const seen: unknown[] = [];
    const service = new ChannelSummaryService({
      intervalMs: 100,
      compareSources: true,
      generateSummary: async (_posts, sources) => {
        seen.push(sources);
        return { text: 'Latest news', keywords: {}, comparison: 'Comparison' };
      },
      onUpdate() {},
    });
    try {
      service.notePost('Old X post', 'x');
      now += 101;
      service.notePost('Recent Bluesky post', 'bluesky');
      await service.flush();
      expect(seen).toEqual([undefined]);
      expect(service.getSnapshot().comparison).toContain('Waiting for recent X posts');
    } finally { clock.mockRestore(); }
  });

  test('does not request or publish comparisons for single-source channels', async () => {
    const service = new ChannelSummaryService({
      generateSummary: async (_posts, sources) => {
        expect(sources).toBeUndefined();
        return { text: 'Latest news', keywords: {}, comparison: 'Ignored' };
      },
      onUpdate() {},
    });
    service.notePost('Bluesky news', 'bluesky');
    await service.flush();
    expect(service.getSnapshot().comparison).toBeUndefined();
  });

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

  test('passes IDs with post bodies and publishes only IDs from that summary window', async () => {
    let chosen = 'odd-post';
    const service = new ChannelSummaryService({
      generateSummary: async posts => {
        expect(posts).toEqual([{ id: 'odd-post', text: 'The moon is a cat egg', source: 'bluesky' }]);
        return { text: 'Cats.', keywords: {}, spotlightPostId: chosen };
      },
      onUpdate() {},
    });
    service.notePost('The moon is a cat egg', 'bluesky', 'odd-post');
    await service.flush();
    expect(service.getSnapshot().spotlightPostId).toBe('odd-post');
    expect(service.getSnapshot().text).toBe('Cats.');
    chosen = 'not-in-the-window';
    await service.flush();
    expect(service.getSnapshot().spotlightPostId).toBeUndefined();
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

describe('OpenRouter summaries', () => {
  const summarize = (posts: string[], sources?: SourceSamples) =>
    generateOpenRouterSummary(posts.map((text, index) => ({ id: String(index), text })), sources);
  const originalApiKey = process.env.OPENROUTER_KEY;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
    if (originalApiKey === undefined) delete process.env.OPENROUTER_KEY;
    else process.env.OPENROUTER_KEY = originalApiKey;
  });

  function mockResponse(body: unknown, status = 200) {
    process.env.OPENROUTER_KEY = 'test-key';
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }));
    return fetchSpy;
  }

  test('requests a grounded comparison in the same summary call', async () => {
    const requests = mockResponse({ choices: [{ message: { content: JSON.stringify({
      summary: 'Cat news', keywords: {}, comparison: 'Both discuss cats. Bluesky shares photos; X discusses adoption.',
    }) } }] });
    const samples = { bluesky: ['Cat photos'], x: ['Cat adoption'] };
    const result = await summarize(['Cat photos', 'Cat adoption'], samples);
    expect(result.comparison).toContain('Bluesky shares photos');
    expect(requests).toHaveBeenCalledTimes(1);
    const body = JSON.parse(requests.mock.calls[0]![1]!.body as string);
    expect(JSON.parse(body.messages[1].content).comparison_samples).toEqual(samples);
    expect(body.messages[0].content).toContain('Do not invent');
    expect(body.messages[0].content).toContain('"comparison"');
  });

  test('rejects a missing comparison when both source samples are provided', async () => {
    mockResponse({ choices: [{ message: { content: JSON.stringify({ summary: 'Cat news', keywords: {} }) } }] });
    await expect(summarize(['cats'], { bluesky: ['cats'], x: ['cats'] })).rejects.toThrow('missing source comparison');
  });

  test('explains exhausted credits and stops repeated quota requests', async () => {
    const requests = mockResponse({ error: { code: 402, message: 'Insufficient credits' } }, 402);
    const service = new ChannelSummaryService({
      generateSummary: generateOpenRouterSummary,
      onUpdate() {},
    });
    service.notePost('hello');
    await service.flush();
    await service.flush();
    expect(requests).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().status).toBe('error');
    expect(service.getSnapshot().text).toContain('credits or key budget exhausted');
    expect(service.getSnapshot().text).toContain('restart the app server');
  });

  test('sends the configured key and model to OpenRouter and parses summary JSON', async () => {
    const requests = mockResponse({ choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify({ summary: 'People discuss cats.', keywords: { cats: ['kittens'] } }) },
    }] });
    expect(await summarize(['Cats are great', 'I love kittens'])).toEqual({
      text: 'People discuss cats.', keywords: { cats: ['kittens'] },
    });
    const [url, options] = requests.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer test-key');
    const body = JSON.parse(options?.body as string);
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.messages[0].role).toBe('system');
    expect(JSON.parse(body.messages[1].content)).toEqual({ recent_posts: [
      { id: '0', text: 'Cats are great' }, { id: '1', text: 'I love kittens' },
    ] });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('selects a supplied post ID without adding it to displayed summary text', async () => {
    const requests = mockResponse({ choices: [{ message: { content: JSON.stringify({
      summary: 'People discuss cats.', keywords: {}, spotlight_post_id: '1',
    }) } }] });
    expect(await summarize(['Cats are great', 'The moon is a cat egg'])).toEqual({
      text: 'People discuss cats.', keywords: {}, spotlightPostId: '1',
    });
    const body = JSON.parse(requests.mock.calls[0]![1]!.body as string);
    expect(body.messages[0].content).toContain('off-kilter');
    expect(body.messages[0].content).toContain('Do not include the selected ID');
  });

  test('missing, invalid, or invented spotlight IDs preserve the summary and allow random fallback', async () => {
    for (const spotlight_post_id of [undefined, null, 12, 'invented', '']) {
      mockResponse({ choices: [{ message: { content: JSON.stringify({
        summary: 'Cats.', keywords: {}, spotlight_post_id,
      }) } }] });
      expect(await summarize(['Cats'])).toEqual({ text: 'Cats.', keywords: {} });
      fetchSpy!.mockRestore();
    }
  });

  test('reports a missing key without making a request', async () => {
    const requests = mockResponse({});
    delete process.env.OPENROUTER_KEY;
    await expect(summarize(['hello'])).rejects.toThrow('missing OPENROUTER_KEY');
    expect(requests).not.toHaveBeenCalled();
  });

  test('reports invalid credentials', async () => {
    mockResponse({ error: { code: 401 } }, 401);
    await expect(summarize(['hello'])).rejects.toThrow('Check OPENROUTER_KEY');
  });

  test('rejects incomplete and invalid summaries', async () => {
    const requests = mockResponse({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] });
    await expect(summarize(['hello'])).rejects.toThrow('output token limit');
    requests.mockImplementation(async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }));
    await expect(summarize(['hello'])).rejects.toThrow('parse failed');
  });

  test('handles provider errors returned with HTTP 200', async () => {
    mockResponse({ error: { code: 503, message: 'Unavailable' } });
    await expect(summarize(['hello'])).rejects.toThrow('failed with 503');
  });

  test('keeps temporary rate limits distinct from quota errors', async () => {
    const requests = mockResponse({ error: { code: 429 } }, 429);
    const service = new ChannelSummaryService({ generateSummary: generateOpenRouterSummary, onUpdate() {} });
    service.notePost('hello');
    await service.flush();
    await service.flush();
    expect(requests).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().text).toContain('rate limit reached');
  });

  test('handles a non-JSON 429 response', async () => {
    mockResponse(null);
    fetchSpy!.mockImplementation(async () => new Response('Too many requests', { status: 429 }));
    await expect(summarize(['hello'])).rejects.toThrow('rate limit reached');
  });
});
