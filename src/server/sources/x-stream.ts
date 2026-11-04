import { createHash } from 'node:crypto';
import { normalizeFilters, type GenericPost } from '../models/post.ts';
import type { PostSourceAdapter, SourceCallbacks } from './source.ts';

type Subscription = { channelKey: string; filterTexts: string[]; callbacks: SourceCallbacks };
type Rule = { id: string; value: string; tag?: string };
type RuleResponse = { data?: Rule[]; errors?: unknown[]; meta?: { next_token?: string } };
type XPayload = {
  data?: {
    id: string; text: string; author_id?: string; created_at?: string; lang?: string;
    note_tweet?: { text: string }; attachments?: { media_keys?: string[] };
  };
  includes?: {
    users?: Array<{ id: string; username: string }>;
    media?: Array<{ media_key: string; type: string; url?: string; alt_text?: string }>;
  };
  errors?: unknown[];
};

// Treat chips as literal words/phrases, never as arbitrary X query operators.
export function xRuleValue(filter: string): string {
  if (/["\\\r\n]/.test(filter) || !/[\p{L}\p{N}]/u.test(filter)) {
    throw new Error('X filters must contain words and cannot contain quotes, backslashes, or newlines.');
  }
  const value = `"${filter}" lang:en -is:retweet`;
  if (value.length > 1024) throw new Error('An X filter exceeds the 1,024-character rule limit.');
  return value;
}

export function normalizeXPost(payload: XPayload): Omit<GenericPost, 'channelKey'> | null {
  const data = payload.data;
  if (!data?.id || typeof data.text !== 'string') return null;
  const username = payload.includes?.users?.find(user => user.id === data.author_id)?.username ?? data.author_id ?? 'unknown';
  const mediaKeys = new Set(data.attachments?.media_keys ?? []);
  return {
    id: `x:${data.id}`, source: 'x', authorId: data.author_id ?? '', username,
    profileUrl: `https://x.com/${encodeURIComponent(username)}`,
    postUrl: `https://x.com/i/web/status/${encodeURIComponent(data.id)}`,
    text: data.note_tweet?.text ?? data.text,
    createdAt: data.created_at ?? new Date().toISOString(), language: data.lang,
    images: (payload.includes?.media ?? [])
      .filter(media => mediaKeys.has(media.media_key) && media.type === 'photo' && media.url)
      .map(media => ({ url: media.url!, alt: media.alt_text ?? '' })),
  };
}

class XHttpError extends Error {
  constructor(readonly status: number, readonly retryMs: number) {
    super(`X API returned HTTP ${status}. ${
      status === 401 ? 'Check X_BEARER_TOKEN.' :
      status === 402 ? 'Check your X API credit balance.' :
      status === 403 ? 'Check your app’s filtered-stream access.' :
      status === 429 ? 'Rate limited; waiting before retrying.' :
      status === 400 ? 'Check filter syntax and rule limits.' : 'The connection will retry.'
    }`);
  }
}

/** One manager per server process. Only rules with our configured tag prefix are managed. */
export class XStreamManager {
  private subscriptions = new Set<Subscription>();
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly prefix: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private streamTask: Promise<void> | null = null;
  private retryMs = 1000;
  private blocked = false;
  private seen = new Set<string>();
  private used = false;
  private status = 'X connecting…';

  constructor(config: { token?: string; fetcher?: typeof fetch; rulePrefix?: string } = {}) {
    this.token = config.token ?? process.env.X_BEARER_TOKEN ?? '';
    this.fetcher = config.fetcher ?? fetch;
    this.prefix = config.rulePrefix ?? process.env.X_RULE_PREFIX ?? 'firehose:';
    if (!this.prefix.trim()) throw new Error('X_RULE_PREFIX must not be empty.');
  }

  source(config: Subscription): PostSourceAdapter {
    const subscription = { ...config, filterTexts: normalizeFilters(config.filterTexts) };
    let started = false;
    return {
      start: () => {
        if (started) return;
        const report = (message: string) => queueMicrotask(() => config.callbacks.onSystemMessage(message));
        if (!this.token) { report('X unavailable: set X_BEARER_TOKEN in .env and restart.'); return; }
        if (!subscription.filterTexts.length) { report('X waiting: add at least one filter.'); return; }
        try { subscription.filterTexts.forEach(xRuleValue); }
        catch (error) { report((error as Error).message); return; }
        started = true;
        this.used = true;
        this.subscriptions.add(subscription);
        this.blocked = false;
        report(this.controller && !this.controller.signal.aborted ? this.status : 'X connecting…');
        this.schedule();
      },
      stop: () => {
        if (!started) return;
        started = false;
        this.subscriptions.delete(subscription);
        if (!this.subscriptions.size) this.controller?.abort();
        this.schedule();
      },
    };
  }

  private message(message: string) {
    this.status = message;
    for (const sub of this.subscriptions) sub.callbacks.onSystemMessage(message);
  }

  private schedule(delay = 300) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = this.pending.then(() => this.reconcile()).catch(error => this.handleError(error));
    }, delay);
    this.timer.unref?.();
  }

  private handleError(error: unknown) {
    // Do not forward response bodies or transport errors that could contain credentials.
    this.message(error instanceof XHttpError ? error.message : 'X connection failed; retrying.');
    if (error instanceof XHttpError && [400, 401, 402, 403].includes(error.status)) {
      this.blocked = true;
      this.controller?.abort();
      return;
    }
    const delay = error instanceof XHttpError ? Math.max(error.retryMs, this.retryMs) : this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 120_000);
    this.schedule(delay);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`https://api.x.com/2/tweets/search/stream${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const reset = Number(response.headers.get('x-rate-limit-reset')) * 1000 - Date.now();
      const retry = retryAfter ? (Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now()) : reset;
      await response.body?.cancel();
      throw new XHttpError(response.status, Math.max(1000, retry || (response.status === 429 ? 60_000 : 1000)));
    }
    return response;
  }

  private async rules(body?: unknown, nextToken?: string): Promise<RuleResponse> {
    const response = await this.request(`/rules${nextToken ? `?pagination_token=${encodeURIComponent(nextToken)}` : ''}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});
    const result = await response.json() as RuleResponse;
    if (result.errors?.length) throw new XHttpError(400, 0);
    return result;
  }

  private async reconcile() {
    if (this.blocked && this.subscriptions.size) return;
    const values = [...new Set([...this.subscriptions].flatMap(sub => sub.filterTexts.map(xRuleValue)))];
    if (values.length > 1000) { this.message('X rule limit reached: reduce the number of active filters.'); this.blocked = true; this.controller?.abort(); return; }
    const existing: Rule[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.rules(undefined, nextToken);
      existing.push(...(page.data ?? []));
      nextToken = page.meta?.next_token;
    } while (nextToken);
    const owned = existing.filter(rule => rule.tag?.startsWith(this.prefix));
    const remove = owned.filter(rule => !values.includes(rule.value)).map(rule => rule.id);
    if (remove.length) await this.rules({ delete: { ids: remove } });
    const add = values.filter(value => !owned.some(rule => rule.value === value))
      .map(value => ({ value, tag: `${this.prefix}${createHash('sha256').update(value).digest('hex').slice(0, 24)}` }));
    if (add.length) await this.rules({ add });
    if (!this.subscriptions.size) { this.controller?.abort(); return; }
    // An aborted prior stream must finish before opening another connection.
    if (this.controller?.signal.aborted) await this.streamTask;
    if (!this.controller && !this.blocked) {
      const controller = new AbortController();
      this.controller = controller;
      this.streamTask = this.consume(controller).catch(error => {
        if (!controller.signal.aborted) this.handleError(error);
      }).finally(() => { if (this.controller === controller) this.controller = null; });
    }
  }

  private async consume(controller: AbortController) {
    const params = new URLSearchParams({
      'tweet.fields': 'created_at,author_id,lang,attachments,note_tweet',
      expansions: 'author_id,attachments.media_keys', 'user.fields': 'username',
      'media.fields': 'url,alt_text,type',
    });
    let heartbeat = setTimeout(() => controller.abort(new Error('X heartbeat timeout')), 90_000);
    heartbeat.unref?.();
    const armHeartbeat = () => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => {
        controller.abort();
        if (this.subscriptions.size) { this.message('X timed out; reconnecting.'); this.schedule(1000); }
      }, 90_000);
      heartbeat.unref?.();
    };
    armHeartbeat();
    try {
      const response = await this.request(`?${params}`, { signal: controller.signal });
      if (!response.body) throw new Error('Missing stream body');
      this.message('X connected.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          armHeartbeat();
          this.retryMs = 1000;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            let payload: XPayload;
            try { payload = JSON.parse(line); } catch { continue; }
            if (payload.errors?.length) throw new Error('X stream error');
            const post = normalizeXPost(payload);
            if (!post || (post.language && post.language !== 'en') || this.seen.has(post.id)) continue;
            this.seen.add(post.id);
            if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!);
            for (const sub of this.subscriptions) {
              if (sub.filterTexts.some(filter => post.text.toLowerCase().includes(filter))) {
                sub.callbacks.onPost({ ...post, channelKey: sub.channelKey });
              }
            }
          }
          if (buffer.length > 2_000_000) throw new Error('Oversized X stream frame');
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!controller.signal.aborted) throw new Error('X stream ended');
    } finally { clearTimeout(heartbeat); }
  }

  async close() {
    this.subscriptions.clear();
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.pending;
    await this.streamTask;
    if (this.token && this.used) {
      try { await this.reconcile(); } catch { console.warn('Could not remove inactive X rules; they will be reconciled on next connection.'); }
    }
    if (this.timer) clearTimeout(this.timer);
  }
}
