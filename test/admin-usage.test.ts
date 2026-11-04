import { describe, expect, test } from 'bun:test';
import { AdminUsageService } from '../src/server/admin-usage.ts';

const today = Date.parse('2026-10-20T12:00:00Z');

function setup(overrides: Record<string, unknown> = {}) {
  let calls = 0;
  const replies: Record<string, unknown> = {
    '/2/usage/tweets': { daily_project_usage: { usage: [{ date: '2026-10-19T00:00:00Z', usage: '48' }] } },
    '/2/usage/credits': { total_balance: 12.5 },
    '/api/v1/credits': { total_credits: 100, total_usage: 23.5 },
    '/api/v1/key': { limit_remaining: 4.25, usage_daily: 0.125 },
    '/api/v1/activity': [
      { date: '2026-10-19', usage: 0.25, requests: 2, prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 20 },
      { date: '2026-10-19', usage: 0.5, requests: 3, prompt_tokens: 200, completion_tokens: 70 },
    ],
    ...overrides,
  };
  const fetcher = (async (input: string | URL | Request, options?: RequestInit) => {
    calls++;
    const path = new URL(String(input)).pathname;
    const expectedKey = path === '/api/v1/activity' || path === '/api/v1/credits' ? 'management-secret' : path.startsWith('/2/') ? 'x-secret' : 'router-secret';
    expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${expectedKey}`);
    const value = replies[path];
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value.clone();
    return Response.json({ data: value });
  }) as typeof fetch;
  return { fetcher, calls: () => calls };
}

const config = { xToken: 'x-secret', openRouterKey: 'router-secret', managementKey: 'management-secret', now: () => today };

describe('admin usage', () => {
  test('aggregates provider daily usage and balances with correct units and scopes', async () => {
    const { fetcher } = setup();
    const report = await new AdminUsageService({ ...config, fetcher }).getUsage();
    expect(report.x.remaining).toBe(12.5);
    expect(report.openRouter.remaining).toBe(76.5);
    expect(report.openRouter.keyRemaining).toBe(4.25);
    expect(report.openRouter.todayKeySpend).toBe(0.125);
    expect(report.daily[1]).toEqual({ date: '2026-10-19', xPosts: 48, openRouterSpend: 0.75, openRouterRequests: 5, openRouterTokens: 420 });
    expect(report.daily[0]!.openRouterSpend).toBeNull();
    expect(report.daily.at(-1)!.xPosts).toBeNull();
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  test('caches reports for one minute and combines simultaneous loads', async () => {
    const mock = setup();
    let time = today;
    const service = new AdminUsageService({ ...config, fetcher: mock.fetcher, now: () => time });
    const [first, second] = await Promise.all([service.getUsage(), service.getUsage()]);
    expect(first).toBe(second);
    await service.getUsage();
    expect(mock.calls()).toBe(5);
    time += 60_001;
    await service.getUsage();
    expect(mock.calls()).toBe(10);
  });

  test('keeps working providers visible and hides transport error details', async () => {
    const { fetcher } = setup({ '/2/usage/tweets': new Error('x-secret'), '/api/v1/activity': new Response('private details', { status: 403 }) });
    const report = await new AdminUsageService({ ...config, fetcher }).getUsage();
    expect(report.x.remaining).toBe(12.5);
    expect(report.daily.every(row => row.xPosts === null)).toBe(true);
    expect(report.openRouter.historyAvailable).toBe(false);
    expect(report.openRouter.notices.join(' ')).toContain('HTTP 403');
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(JSON.stringify(report)).not.toContain('private details');
  });

  test('explains missing keys without making network requests or inventing zero balances', async () => {
    const mock = setup();
    const report = await new AdminUsageService({ xToken: '', openRouterKey: '', managementKey: '', fetcher: mock.fetcher }).getUsage();
    expect(mock.calls()).toBe(0);
    expect(report.x.remaining).toBeNull();
    expect(report.openRouter.remaining).toBeNull();
    expect(report.openRouter.notices.join(' ')).toContain('OPENROUTER_MANAGEMENT_KEY');
    expect(report.daily.every(row => row.openRouterSpend === null)).toBe(true);
  });

  test('does not treat missing provider totals as zero', async () => {
    const { fetcher } = setup({ '/api/v1/credits': {}, '/2/usage/tweets': {} });
    const report = await new AdminUsageService({ ...config, fetcher }).getUsage();
    expect(report.openRouter.remaining).toBeNull();
    expect(report.x.usageAvailable).toBe(false);
    expect(report.daily.every(row => row.xPosts === null)).toBe(true);
  });
});
