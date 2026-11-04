export type DailyUsage = {
  date: string;
  xPosts: number | null;
  openRouterSpend: number | null;
  openRouterRequests: number | null;
  openRouterTokens: number | null;
};

export type AdminUsage = {
  updatedAt: string;
  x: { remaining: number | null; usageAvailable: boolean; notices: string[] };
  openRouter: { remaining: number | null; keyRemaining: number | null; todayKeySpend: number | null; historyAvailable: boolean; notices: string[] };
  daily: DailyUsage[];
};

type Config = {
  xToken?: string;
  openRouterKey?: string;
  managementKey?: string;
  fetcher?: typeof fetch;
  now?: () => number;
};

class UsageError extends Error {}

function number(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function day(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? value.slice(0, 10) : null;
}

/** Provider-reported usage, cached across visitors to avoid consuming rate limits. */
export class AdminUsageService {
  private cached: AdminUsage | null = null;
  private pending: Promise<AdminUsage> | null = null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: Config = {}) {
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? Date.now;
  }

  getUsage(): Promise<AdminUsage> {
    if (this.cached && this.now() - Date.parse(this.cached.updatedAt) < 60_000) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.load().then(result => { this.cached = result; return result; }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async request(url: string, token: string | undefined, setting: string): Promise<any> {
    if (!token) throw new UsageError(`Set ${setting} to enable this report.`);
    try {
      const response = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UsageError(`Provider returned HTTP ${response.status}. Check ${setting} and its permissions.`);
      }
      const body = await response.json() as { data?: unknown; errors?: unknown[]; error?: unknown };
      if (body?.data == null || body.error || body.errors?.length) throw new UsageError('Provider returned an incomplete usage report.');
      return body.data;
    } catch (error) {
      // Never expose upstream bodies or transport errors, which may contain credentials.
      if (error instanceof UsageError) throw error;
      throw new UsageError('Usage request failed or timed out. Try refreshing later.');
    }
  }

  private async load(): Promise<AdminUsage> {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const midnight = Date.parse(`${today}T00:00:00Z`);
    const xToken = this.config.xToken ?? process.env.X_BEARER_TOKEN;
    const key = this.config.openRouterKey ?? process.env.OPENROUTER_KEY;
    const management = this.config.managementKey ?? process.env.OPENROUTER_MANAGEMENT_KEY;
    const results = await Promise.allSettled([
      this.request('https://api.x.com/2/usage/tweets?days=30&usage.fields=daily_project_usage,project_usage', xToken, 'X_BEARER_TOKEN'),
      this.request('https://api.x.com/2/usage/credits', xToken, 'X_BEARER_TOKEN'),
      this.request('https://openrouter.ai/api/v1/credits', management || key, management ? 'OPENROUTER_MANAGEMENT_KEY' : 'OPENROUTER_KEY'),
      this.request('https://openrouter.ai/api/v1/key', key, 'OPENROUTER_KEY'),
      this.request('https://openrouter.ai/api/v1/activity', management, 'OPENROUTER_MANAGEMENT_KEY'),
    ]);
    const report: AdminUsage = {
      updatedAt: new Date(this.now()).toISOString(),
      x: { remaining: null, usageAvailable: false, notices: [] },
      openRouter: { remaining: null, keyRemaining: null, todayKeySpend: null, historyAvailable: false, notices: [] },
      daily: Array.from({ length: 31 }, (_, index) => ({
        date: new Date(midnight - index * 86_400_000).toISOString().slice(0, 10),
        xPosts: null, openRouterSpend: null, openRouterRequests: null, openRouterTokens: null,
      })),
    };
    const read = (index: number, label: string, notices: string[]) => {
      const result = results[index]!;
      if (result.status === 'fulfilled') return result.value;
      notices.push(`${label}: ${result.reason instanceof UsageError ? result.reason.message : 'Report unavailable.'}`);
      return null;
    };
    const xUsage = read(0, 'Daily usage', report.x.notices);
    const xCredits = read(1, 'Balance', report.x.notices);
    const credits = read(2, 'Account balance', report.openRouter.notices);
    const keyInfo = read(3, 'Current key', report.openRouter.notices);
    const activity = read(4, 'Daily history', report.openRouter.notices);
    if (xCredits) report.x.remaining = number(xCredits.total_balance);
    if (credits) {
      const total = number(credits.total_credits);
      const used = number(credits.total_usage);
      if (total !== null && used !== null) report.openRouter.remaining = Math.max(0, total - used);
    }
    if (keyInfo) {
      report.openRouter.keyRemaining = number(keyInfo.limit_remaining);
      report.openRouter.todayKeySpend = number(keyInfo.usage_daily);
    }
    const xDays = xUsage?.daily_project_usage?.usage;
    if (Array.isArray(xDays)) {
      report.x.usageAvailable = true;
      for (const row of report.daily.slice(0, 30)) row.xPosts = 0;
      for (const entry of xDays) {
        const row = report.daily.find(row => row.date === day(entry.date));
        if (row) row.xPosts = number(entry.usage);
      }
    } else if (xUsage) report.x.notices.push('Daily usage: provider did not include daily post counts.');
    if (Array.isArray(activity)) {
      report.openRouter.historyAvailable = true;
      for (const row of report.daily.slice(1)) {
        row.openRouterSpend = 0; row.openRouterRequests = 0; row.openRouterTokens = 0;
      }
      for (const entry of activity) {
        const row = report.daily.find(row => row.date !== today && row.date === day(entry.date));
        if (!row) continue;
        row.openRouterSpend = (row.openRouterSpend ?? 0) + (number(entry.usage) ?? 0);
        row.openRouterRequests = (row.openRouterRequests ?? 0) + (number(entry.requests) ?? 0);
        // Reasoning tokens are included in completion_tokens; do not double count them.
        row.openRouterTokens = (row.openRouterTokens ?? 0) + (number(entry.prompt_tokens) ?? 0) + (number(entry.completion_tokens) ?? 0);
      }
    } else if (activity) report.openRouter.notices.push('Daily history: provider returned an invalid report.');
    return report;
  }
}

export const adminUsage = new AdminUsageService();
