import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { checkSitePassword } from '../src/server/site-auth.ts';

const password = 'test-site-password';
const request = (path = '/', cookie?: string) => new Request(`https://firehose.test${path}`, {
  headers: cookie ? { Cookie: cookie } : undefined,
});
const login = (value: string, url = 'https://firehose.test/?filter=bun') => checkSitePassword(new Request(url, {
  method: 'POST', body: new URLSearchParams({ password: value }),
}), password);

describe('site password', () => {
  test('leaves the app open without a configured password', async () => {
    expect(await checkSitePassword(request(), '')).toBeNull();
    expect(await checkSitePassword(request('/events'), '')).toBeNull();
  });

  test('shows the password screen and blocks direct endpoint access', async () => {
    const page = await checkSitePassword(request(), password);
    expect(page?.status).toBe(200);
    expect(await page?.text()).toContain('type="password"');
    for (const path of ['/events', '/web/app.js', '/reset-bigrams']) {
      expect((await checkSitePassword(request(path), password))?.status).toBe(401);
    }
    expect((await checkSitePassword(new Request('https://firehose.test/reset-bigrams', { method: 'POST' }), password))?.status).toBe(401);
  });

  test('rejects incorrect passwords without setting a cookie', async () => {
    const response = await login('wrong');
    expect(response?.status).toBe(401);
    expect(response?.headers.get('set-cookie')).toBeNull();
    expect(await response?.text()).toContain('Incorrect password');
  });

  test('persists access with a secure 24-hour cookie and retains filters', async () => {
    const response = await login(password);
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/?filter=bun');
    const cookie = response!.headers.get('set-cookie')!;
    for (const attribute of ['Max-Age=86400', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain(password);
    const pair = cookie.split(';')[0]!;
    expect(await checkSitePassword(request('/', pair), password)).toBeNull();
    expect(await checkSitePassword(request('/events', pair), password)).toBeNull();
    expect((await checkSitePassword(request('/events', pair), 'changed-password'))?.status).toBe(401);
    expect((await checkSitePassword(request('/events', pair + '0'), password))?.status).toBe(401);
  });

  test('rejects expired, forged, and malformed cookies', async () => {
    const value = `${Date.now() - 1000}.${'a'.repeat(64)}`;
    const signature = createHmac('sha256', password).update(`firehose-session:${value}`).digest('hex');
    for (const token of [`${value}.${signature}`, 'invalid', '%broken', `${Date.now() + 60000}.${'a'.repeat(64)}.${'b'.repeat(64)}`]) {
      expect((await checkSitePassword(request('/events', `firehose_session=${token}`), password))?.status).toBe(401);
    }
  });

  test('supports local HTTP and rejects cross-origin login submissions', async () => {
    expect((await login(password, 'http://localhost:3000/'))?.headers.get('set-cookie')).not.toContain('Secure');
    const response = await checkSitePassword(new Request('https://firehose.test/', {
      method: 'POST', headers: { Origin: 'https://other.test' },
      body: new URLSearchParams({ password }),
    }), password);
    expect(response?.status).toBe(403);
  });

  test('accepts same-origin HTTPS login through Caddy and issues a usable secure cookie', async () => {
    const response = await checkSitePassword(new Request('http://firehose.test/?filter=bun', {
      method: 'POST',
      headers: { Origin: 'https://firehose.test', 'X-Forwarded-Proto': 'https' },
      body: new URLSearchParams({ password }),
    }), password);
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/?filter=bun');
    const cookie = response!.headers.get('set-cookie')!;
    expect(cookie).toContain('; Secure');
    expect(await checkSitePassword(request('/', cookie.split(';')[0]!), password)).toBeNull();
  });

  test('still rejects a different host or scheme behind Caddy', async () => {
    for (const origin of ['https://other.test', 'http://firehose.test', 'null']) {
      const response = await checkSitePassword(new Request('http://firehose.test/', {
        method: 'POST',
        headers: { Origin: origin, 'X-Forwarded-Proto': 'https' },
        body: new URLSearchParams({ password }),
      }), password);
      expect(response?.status).toBe(403);
      expect(response?.headers.get('set-cookie')).toBeNull();
    }
  });
});
