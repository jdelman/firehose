import { afterEach, describe, expect, test } from 'bun:test';
import { routeRequest } from '../src/server/routes.ts';
import { ChannelRegistry } from '../src/server/channel-registry.ts';
import { InMemoryPubSubAdapter } from '../src/server/pubsub/in-memory-pubsub.ts';

const originalFlag = process.env.ENABLE_X;
const originalPassword = process.env.SITE_PASSWORD;
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_X;
  else process.env.ENABLE_X = originalFlag;
  if (originalPassword === undefined) delete process.env.SITE_PASSWORD;
  else process.env.SITE_PASSWORD = originalPassword;
});

function setup(flag?: string) {
  delete process.env.SITE_PASSWORD;
  if (flag === undefined) delete process.env.ENABLE_X;
  else process.env.ENABLE_X = flag;
  const started: string[][] = [];
  const registry = new ChannelRegistry({
    pubsub: new InMemoryPubSubAdapter(),
    createSource: ({ sources }) => ({ start() { started.push(sources); }, stop() {} }),
  });
  return { started, request: (path: string) => routeRequest(new Request(`https://firehose.test${path}`), registry) };
}

describe('X availability', () => {
  test.each([undefined, 'false', '0', ''])('defaults to disabled for %s and rejects direct X streams', async flag => {
    const app = setup(flag);
    const page = await app.request('/?source=x');
    const html = await page.text();
    expect(html).toContain('data-enable-x="false"');
    expect(html).toContain('id="source-x-toggle" class="toolbar-toggle" hidden');
    expect(html).toContain('id="source-x" type="checkbox" disabled');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/events?source=x&filter=cats')).status).toBe(400);
    expect(app.started).toEqual([]);
  });

  test('strips X from combined saved subscriptions while retaining Bluesky', async () => {
    const app = setup('false');
    const response = await app.request('/events?source=bluesky&source=x&filter=cats');
    try {
      expect(response.status).toBe(200);
      expect(app.started).toEqual([['bluesky']]);
    } finally { await response.body?.cancel(); }
  });

  test('enables the checkbox configuration and X streams only when true', async () => {
    const app = setup('true');
    expect(await (await app.request('/')).text()).toContain('data-enable-x="true"');
    const response = await app.request('/events?source=x&filter=cats');
    try {
      expect(response.status).toBe(200);
      expect(app.started).toEqual([['x']]);
    } finally { await response.body?.cancel(); }
  });
});
