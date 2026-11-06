import { afterEach, describe, expect, test } from 'bun:test';
import { routeRequest } from '../src/server/routes.ts';
import { ChannelRegistry } from '../src/server/channel-registry.ts';
import { InMemoryPubSubAdapter } from '../src/server/pubsub/in-memory-pubsub.ts';

const originalPassword = process.env.SITE_PASSWORD;
afterEach(() => {
  if (originalPassword === undefined) delete process.env.SITE_PASSWORD;
  else process.env.SITE_PASSWORD = originalPassword;
});
const registry = new ChannelRegistry({ pubsub: new InMemoryPubSubAdapter(), createSource: () => ({ start() {}, stop() {} }) });
const request = (path: string, options?: RequestInit) => new Request(`https://firehose.test${path}`, options);

describe('admin routes', () => {
  test.each(['gunshot', 'faa'])('serves the bundled %s audio and protects it with the site password', async (clip) => {
    process.env.SITE_PASSWORD = 'test';
    expect((await routeRequest(request(`/sounds/${clip}.m4a`), registry)).status).not.toBe(200);
    delete process.env.SITE_PASSWORD;
    const response = await routeRequest(request(`/sounds/${clip}.m4a`), registry);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/mp4');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe('ftyp');
    const head = await routeRequest(request(`/sounds/${clip}.m4a`, { method: 'HEAD' }), registry);
    expect(head.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(await head.text()).toBe('');
    const versioned = await routeRequest(request(`/sounds/${clip}.m4a?v=clean-fade-full`), registry);
    expect(versioned.status).toBe(200);
    expect(new Uint8Array(await versioned.arrayBuffer())).toEqual(bytes);
    const write = await routeRequest(request(`/sounds/${clip}.m4a`, { method: 'POST' }), registry);
    expect(write.status).toBe(405);
    expect(write.headers.get('Allow')).toBe('GET, HEAD');
  });

  test('requires sign-in and returns to admin after unlocking', async () => {
    process.env.SITE_PASSWORD = 'admin-test-password';
    const redirect = await routeRequest(request('/admin'), registry);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('location')).toBe('/?next=/admin');
    expect((await routeRequest(request('/admin/usage'), registry)).status).toBe(401);
    expect((await routeRequest(request('/admin/connections'), registry)).status).toBe(401);
    const login = await routeRequest(request('/?next=/admin', { method: 'POST', body: new URLSearchParams({ password: 'admin-test-password' }) }), registry);
    expect(login.headers.get('location')).toBe('/admin');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const page = await routeRequest(request('/admin', { headers: { Cookie: cookie } }), registry);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('Daily usage');
  });

  test('returns uncached connection counts and places them above API usage', async () => {
    delete process.env.SITE_PASSWORD;
    const subscription = registry.subscribe({ filterTexts: [], listener() {} });
    try {
      const response = await routeRequest(request('/admin/connections'), registry);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ blueskyConnections: 0, connectedClients: 1 });
      const page = await (await routeRequest(request('/admin'), registry)).text();
      expect(page.indexOf('id="connections-title"')).toBeLessThan(page.indexOf('<h2>API usage</h2>'));
    } finally { await subscription.unsubscribe(); }
    expect(await (await routeRequest(request('/admin/connections'), registry)).json()).toEqual({ blueskyConnections: 0, connectedClients: 0 });
    expect((await routeRequest(request('/admin/connections', { method: 'POST' }), registry)).status).toBe(405);
  });

  test('serves the admin browser module and rejects writes', async () => {
    delete process.env.SITE_PASSWORD;
    const response = await routeRequest(request('/web/admin.js'), registry);
    const source = await response.text();
    expect(response.status).toBe(200);
    expect(source).toContain('/admin/usage');
    expect(source).not.toContain('server/admin-usage');
    expect((await routeRequest(request('/admin', { method: 'POST' }), registry)).status).toBe(405);
    expect((await routeRequest(request('/admin/usage', { method: 'POST' }), registry)).status).toBe(405);
  });
});
