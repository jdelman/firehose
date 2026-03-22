import type { SummarySnapshot } from './models/events.ts';

export type SummaryResult = {
  text: string;
  keywords: Record<string, string[]>;
};

export type SummaryGenerator = (posts: string[]) => Promise<SummaryResult>;

const DEFAULT_INTERVAL_MS = 10_000;

export class ChannelSummaryService {
  private readonly intervalMs: number;
  private readonly generateSummary: SummaryGenerator;
  private readonly onUpdate: (snapshot: SummarySnapshot) => void;
  private readonly recentPosts: Array<{ text: string; seenAt: number }> = [];
  private inFlight = false;
  private timer: Timer | null = null;
  private snapshot: SummarySnapshot = {
    text: 'Waiting for the first 10-second window.',
    keywords: {},
    updatedAt: null,
    status: 'idle',
  };

  constructor(config: {
    intervalMs?: number;
    generateSummary: SummaryGenerator;
    onUpdate: (snapshot: SummarySnapshot) => void;
  }) {
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.generateSummary = config.generateSummary;
    this.onUpdate = config.onUpdate;
  }

  getSnapshot(): SummarySnapshot {
    return this.snapshot;
  }

  start(): void {
    this.publishSnapshot();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  notePost(text: string): void {
    this.recentPosts.push({
      text,
      seenAt: Date.now(),
    });
    this.prune();
  }

  async flush(): Promise<void> {
    await this.tick();
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.intervalMs;
    while (this.recentPosts.length > 0 && this.recentPosts[0]!.seenAt < cutoff) {
      this.recentPosts.shift();
    }
  }

  private publishSnapshot(): void {
    this.onUpdate({ ...this.snapshot });
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.prune();
    const posts = this.recentPosts.map((entry) => entry.text);

    if (posts.length === 0) {
      this.snapshot = {
        ...this.snapshot,
        status: 'idle',
      };
      this.publishSnapshot();
      return;
    }

    this.inFlight = true;
    this.snapshot = {
      ...this.snapshot,
      status: 'updating',
    };
    this.publishSnapshot();

    try {
      const result = await this.generateSummary(posts);
      this.snapshot = {
        text: result.text,
        keywords: result.keywords,
        updatedAt: new Date().toISOString(),
        status: 'idle',
      };
      this.publishSnapshot();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Summary generation failed';
      this.snapshot = {
        ...this.snapshot,
        text: `Unavailable: ${message}`,
        status: 'error',
      };
      this.publishSnapshot();
    } finally {
      this.inFlight = false;
    }
  }
}

export async function generateOpenAiSummary(posts: string[]): Promise<SummaryResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('missing OPENAI_API_KEY');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5-mini-2025-08-07',
      instructions: [
        'You will receive a list of social post bodies from the last 10 seconds.',
        'Return valid JSON with exactly two keys: "summary" and "keywords".',
        'The "summary" value must be one terse plain-text sentence under 200 characters about what people are talking about.',
        'If there is an off-kilter or surprising message, mention it briefly in the summary sentence.',
        'The "keywords" value must be an object with exactly 10 keys.',
        'Each key must be a short filter phrase, 1 to 3 words long, that sounds like something a user could enter into a social media firehose filter and actually match post text.',
        'Each object value must be an array of exactly 5 other related search terms for that key.',
        'Prefer literal quoted phrases, slogans, names, nicknames, hashtags without the # symbol, chant-like fragments, and repeated word pairs taken from the kinds of language people are actually using.',
        'Do not use abstract topic labels or analyst summaries like "political outrage" or "economic anxiety" unless those exact words are likely to appear in posts.',
        'Do not include labels, markdown, or any extra text outside the JSON object.',
      ].join(' '),
      input: posts.join('\n\n'),
      reasoning: {
        effort: 'minimal',
      },
      text: {
        verbosity: 'low',
      },
      max_output_tokens: 700,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`summary request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{
        text?: string;
      }>;
    }>;
    status?: string;
    incomplete_details?: {
      reason?: string;
    };
  };

  const text = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text?.trim())
    .filter((item): item is string => Boolean(item))
    .join('\n')
    .trim();

  if (data.status === 'incomplete' && data.incomplete_details?.reason) {
    throw new Error(`summary response incomplete (${data.incomplete_details.reason})`);
  }

  const candidate = typeof data.output_text === 'string' && data.output_text.trim()
    ? data.output_text.trim()
    : text;

  if (candidate) {
    try {
      return parseSummaryResult(candidate);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'summary response was not valid JSON';
      throw new Error(`summary response parse failed (${message})`);
    }
  }

  throw new Error('summary response had no text');
}

function parseSummaryResult(value: string): SummaryResult {
  const match = value.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : value;
  const parsed = JSON.parse(jsonText) as {
    summary?: unknown;
    keywords?: unknown;
  };

  const text =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : null;
  const keywords = normalizeKeywordMap(parsed.keywords);

  if (!text) {
    throw new Error('summary response missing summary text');
  }

  return {
    text,
    keywords,
  };
}

function normalizeKeywordMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalizedEntries: Array<[string, string[]]> = [];

  for (const [rawKeyword, rawRelated] of Object.entries(value)) {
    const keyword = rawKeyword.trim();
    if (!keyword) {
      continue;
    }

    const relatedTerms = Array.isArray(rawRelated)
      ? dedupeTerms(
          rawRelated
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => Boolean(item) && item.toLowerCase() !== keyword.toLowerCase()),
        ).slice(0, 5)
      : [];

    normalizedEntries.push([keyword, relatedTerms]);
    if (normalizedEntries.length >= 10) {
      break;
    }
  }

  return Object.fromEntries(normalizedEntries);
}

function dedupeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(term);
  }

  return normalized;
}
